import type { PrStackDetail, StackBrief, WalkthroughStackSnapshot } from "@revv/shared";
import { and, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import type { Db } from "../../db/index";
import { pullRequests } from "../../db/schema/pull-requests";
import { stackBriefs } from "../../db/schema/stack-briefs";
import { walkthroughs } from "../../db/schema/walkthroughs";
import { type DbError, type GitHubError, isGitHubUnreachable } from "../../domain/errors";
import { dbTry } from "../../effects/db-try";
import { logError } from "../../logger";
import { withGitHubOrigin } from "../../observability/github-ledger/origin";
import { CacheService } from "../Cache";
import { DbService } from "../Db";
import { readCurrentHeadFiles, toGitHubFileShape } from "../DiffCache";
import { GitHubGateway } from "../github/gateway";
import type { GitHubStack } from "../github/stacks";
import type { GitHubClient } from "../github/transport";
import {
  type PrContextBasic,
  type PrContextError,
  PrContextService,
  type RepoContext,
} from "../PrContext";
import { Realtime } from "../Realtime";
import { fingerprintFiles, restackCarry, restackSourceOf } from "../walkthrough/restack";
import { latestFinishedReviews } from "../walkthrough/review-reads";
import { type MirroredLayer, membershipSupersededByPoll, stackFromMirror } from "./map";
import {
  overlayStack,
  type RevvStackFacts,
  STACK_REVIEW_REQUEST,
  type TrackedLayer,
} from "./overlay";
import { readBriefLayers } from "./reads";
import { stackSignature } from "./signature";

const CACHE_NS = "pr-stack";
const FRESH_FOR_MS = 30_000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export type StackError = GitHubError | PrContextError | DbError;

const cacheKey = (repositoryId: string, stackNumber: number) => `${repositoryId}:${stackNumber}`;

export class StackService extends Context.Service<
  StackService,
  {
    /**
     * The PR's stack with Revv's overlay, or null when the PR isn't stacked
     * (or the host predates stacks). Serves a read under 30s old from the
     * cache, and the last good one (`stale: true`) when GitHub is unreachable.
     */
    readonly detail: (
      prId: string,
      accountId: string,
    ) => Effect.Effect<PrStackDetail | null, StackError>;
    /** PR #`prNumber`'s stack as GitHub reports it now, cached for the next read. */
    readonly fetchFresh: (
      at: { readonly client: GitHubClient; readonly repo: RepoContext["repo"] },
      prNumber: number,
    ) => Effect.Effect<GitHubStack | null, StackError>;
    readonly snapshot: (ctx: PrContextBasic) => Effect.Effect<WalkthroughStackSnapshot | null>;
    /**
     * Revv or GitHub moved the stack (a push, a retarget, a merge): drop the
     * cached read, so the next one asks GitHub, and tell the account.
     */
    readonly moved: (
      accountId: string,
      repositoryId: string,
      stackNumber: number,
    ) => Effect.Effect<void>;
  }
>()("StackService") {}

export function toSnapshot(stack: GitHubStack, position: number): WalkthroughStackSnapshot {
  return {
    number: stack.number,
    baseRefName: stack.baseRefName,
    position,
    layers: stack.layers.map((l) => ({
      position: l.position,
      number: l.number,
      title: l.title,
      headSha: l.headSha,
      baseRef: l.baseRef,
      status: l.status,
    })),
    capturedAt: stack.fetchedAt,
  };
}

export function readStackFacts(
  db: Db,
  repositoryId: string,
  stack: GitHubStack,
): Effect.Effect<RevvStackFacts, DbError> {
  return dbTry("stack facts read", (): RevvStackFacts => {
    const numbers = stack.layers.map((l) => l.number);
    const prRows = db
      .select({
        id: pullRequests.id,
        externalId: pullRequests.externalId,
        headSha: pullRequests.headSha,
      })
      .from(pullRequests)
      .where(
        and(eq(pullRequests.repositoryId, repositoryId), inArray(pullRequests.externalId, numbers)),
      )
      .all();
    const prIds = prRows.map((r) => r.id);

    const standing =
      prIds.length === 0
        ? []
        : db
            .select({
              id: walkthroughs.id,
              prId: walkthroughs.pullRequestId,
              status: walkthroughs.status,
              prHeadSha: walkthroughs.prHeadSha,
            })
            .from(walkthroughs)
            .where(
              and(
                inArray(walkthroughs.pullRequestId, prIds),
                ne(walkthroughs.status, "superseded"),
              ),
            )
            .orderBy(desc(walkthroughs.generatedAt))
            .all();
    const finished = latestFinishedReviews(db, prIds);
    const filesByPr = readCurrentHeadFiles(db, prIds);

    const tracked = new Map<number, TrackedLayer>();
    for (const pr of prRows) {
      const current = standing.find((w) => w.prId === pr.id && w.prHeadSha === pr.headSha);
      const files = filesByPr.get(pr.id);
      const currentFingerprint = files ? fingerprintFiles(toGitHubFileShape(files)) : null;
      tracked.set(pr.externalId, {
        prId: pr.id,
        currentFingerprint,
        files: files ? files.map((f) => f.path) : null,
        current: current ? { id: current.id, status: current.status } : null,
        latestFinished: finished.get(pr.id) ?? null,
        carries:
          pr.headSha !== null &&
          currentFingerprint !== null &&
          restackCarry(
            restackSourceOf(db, pr.id, pr.headSha, STACK_REVIEW_REQUEST.mode),
            STACK_REVIEW_REQUEST.generationMode,
            currentFingerprint,
          ) !== null,
      });
    }

    return {
      repositoryId,
      tracked,
      brief: readBrief(db, repositoryId, stack),
    };
  });
}

function readMirror(
  db: Db,
  repositoryId: string,
  stackNumber: number,
): Effect.Effect<MirroredLayer[], DbError> {
  return Effect.gen(function* () {
    return yield* dbTry("stack mirror read", () =>
      db
        .select({
          number: pullRequests.externalId,
          position: pullRequests.stackPosition,
          title: pullRequests.title,
          url: pullRequests.url,
          status: pullRequests.status,
          isDraft: pullRequests.isDraft,
          sourceBranch: pullRequests.sourceBranch,
          targetBranch: pullRequests.targetBranch,
          headSha: pullRequests.headSha,
          additions: pullRequests.additions,
          deletions: pullRequests.deletions,
          changedFiles: pullRequests.changedFiles,
          authorLogin: pullRequests.authorLogin,
          closedAt: pullRequests.closedAt,
          fetchedAt: pullRequests.fetchedAt,
        })
        .from(pullRequests)
        .where(
          and(
            eq(pullRequests.repositoryId, repositoryId),
            eq(pullRequests.stackNumber, stackNumber),
          ),
        )
        .all()
        .flatMap((row) => (row.position === null ? [] : [{ ...row, position: row.position }])),
    );
  });
}

type StackSource =
  | { readonly kind: "fresh-cache"; readonly stack: GitHubStack }
  | {
      readonly kind: "cache-then-revalidate";
      readonly stack: GitHubStack;
      readonly accountId: string;
    }
  | { readonly kind: "github"; readonly ifUnreachable: GitHubStack | null };

export function chooseStackSource(args: {
  readonly cached: GitHubStack | null;
  readonly mirror: readonly MirroredLayer[];
  readonly stackNumber: number;
  readonly now: number;
  readonly revalidateFor: string | null;
}): StackSource {
  const { cached, mirror, stackNumber, now, revalidateFor } = args;
  const usable = cached && !membershipSupersededByPoll(cached, mirror) ? cached : null;
  if (usable && now - Date.parse(usable.fetchedAt) < FRESH_FOR_MS) {
    return { kind: "fresh-cache", stack: usable };
  }
  if (usable && revalidateFor !== null) {
    return { kind: "cache-then-revalidate", stack: usable, accountId: revalidateFor };
  }
  return {
    kind: "github",
    ifUnreachable: usable ?? stackFromMirror(stackNumber, mirror, new Date(now).toISOString()),
  };
}

function readBrief(db: Db, repositoryId: string, stack: GitHubStack): StackBrief | null {
  const row = db
    .select()
    .from(stackBriefs)
    .where(
      and(
        eq(stackBriefs.repositoryId, repositoryId),
        eq(stackBriefs.stackNumber, stack.number),
        ne(stackBriefs.status, "superseded"),
        isNull(stackBriefs.supersededBy),
      ),
    )
    .orderBy(desc(stackBriefs.createdAt))
    .get();
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    stale: row.signature !== stackSignature(stack.layers),
    arc: row.arc,
    reviewOrder: row.reviewOrder,
    layers: readBriefLayers(db, row.id),
    completedAt: row.completedAt,
  };
}

export const StackServiceLive = Layer.effect(
  StackService,
  Effect.gen(function* () {
    const { db } = yield* DbService;
    const prContext = yield* PrContextService;
    const github = yield* GitHubGateway;
    const cache = yield* CacheService;
    const realtime = yield* Realtime;
    const revalidating = new Set<string>();
    // Bumped by every move, so a background re-read that started before one
    // can't write the pre-move stack back.
    const moves = new Map<string, number>();
    const movesOf = (key: string) => moves.get(key) ?? 0;

    const store = (repositoryId: string, stack: GitHubStack) =>
      cache.set(CACHE_NS, cacheKey(repositoryId, stack.number), stack, { ttlMs: CACHE_TTL_MS });

    const fetchFresh = (
      { client, repo }: { readonly client: GitHubClient; readonly repo: RepoContext["repo"] },
      prNumber: number,
    ) =>
      Effect.gen(function* () {
        const stack = yield* github.stacks.ofPr(client, repo.fullName, prNumber);
        if (stack) yield* store(repo.id, stack);
        return stack;
      });

    const revalidate = (ctx: PrContextBasic, stackNumber: number, accountId: string) => {
      const key = cacheKey(ctx.repo.id, stackNumber);
      if (revalidating.has(key)) return Effect.void;
      revalidating.add(key);
      const started = movesOf(key);
      return github.stacks.ofPr(ctx.client, ctx.repo.fullName, ctx.pr.externalId).pipe(
        Effect.flatMap((stack) =>
          stack && movesOf(key) === started
            ? store(ctx.repo.id, stack).pipe(
                Effect.andThen(
                  realtime.toAccount(accountId, {
                    type: "stack:updated",
                    data: { repositoryId: ctx.repo.id, stackNumber: stack.number },
                  }),
                ),
              )
            : Effect.void,
        ),
        Effect.catchCause((cause) =>
          Effect.sync(() => logError("stacks", `background re-read of ${key} failed`, cause)),
        ),
        Effect.ensuring(Effect.sync(() => revalidating.delete(key))),
        withGitHubOrigin("stack:revalidate"),
        Effect.forkDetach,
        Effect.asVoid,
      );
    };

    const githubStack = (
      ctx: PrContextBasic,
      stackNumber: number,
      revalidateFor: string | null = null,
    ) =>
      Effect.gen(function* () {
        const mirror = yield* readMirror(db, ctx.repo.id, stackNumber);
        const cached = yield* cache.get<GitHubStack>(CACHE_NS, cacheKey(ctx.repo.id, stackNumber));
        const source = chooseStackSource({
          cached,
          mirror,
          stackNumber,
          now: Date.now(),
          revalidateFor,
        });
        switch (source.kind) {
          case "fresh-cache":
            return { stack: source.stack, stale: false };
          case "cache-then-revalidate":
            yield* revalidate(ctx, stackNumber, source.accountId);
            return { stack: source.stack, stale: false };
          case "github": {
            const { ifUnreachable } = source;
            return yield* fetchFresh(ctx, ctx.pr.externalId).pipe(
              Effect.map((stack) => ({ stack, stale: false })),
              Effect.catchIf(isGitHubUnreachable, (err) =>
                ifUnreachable
                  ? Effect.succeed({ stack: ifUnreachable, stale: true })
                  : Effect.fail(err),
              ),
            );
          }
        }
      });

    const detail = (prId: string, accountId: string) =>
      Effect.gen(function* () {
        const ctx = yield* prContext.forPr(prId, accountId);
        if (!ctx.pr.stack) return null;
        const { stack, stale } = yield* githubStack(ctx, ctx.pr.stack.number, accountId);
        if (!stack) return null;
        const facts = yield* readStackFacts(db, ctx.repo.id, stack);
        return overlayStack(stack, facts, ctx.pr.externalId, stale);
      });

    const snapshot = (ctx: PrContextBasic) =>
      Effect.gen(function* () {
        if (!ctx.pr.stack) return null;
        const { stack } = yield* githubStack(ctx, ctx.pr.stack.number);
        if (!stack) return null;
        const position = stack.layers.find((l) => l.number === ctx.pr.externalId)?.position;
        return position === undefined ? null : toSnapshot(stack, position);
      }).pipe(
        Effect.catch((err) =>
          Effect.sync(() => {
            logError("stacks", `stack snapshot for ${ctx.pr.id} failed`, err);
            return null;
          }),
        ),
      );

    const moved = (accountId: string, repositoryId: string, stackNumber: number) => {
      const key = cacheKey(repositoryId, stackNumber);
      moves.set(key, movesOf(key) + 1);
      return cache.invalidate(CACHE_NS, key).pipe(
        Effect.catch((err) =>
          Effect.sync(() =>
            logError("stacks", `dropping the cached read of stack #${stackNumber}:`, err),
          ),
        ),
        Effect.andThen(
          realtime.toAccount(accountId, {
            type: "stack:updated",
            data: { repositoryId, stackNumber },
          }),
        ),
      );
    };

    return { detail, fetchFresh, snapshot, moved };
  }),
);
