import type { PrStackDetail, RiskLevel, StackBrief, WalkthroughStackSnapshot } from "@revv/shared";
import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { pullRequests } from "../../db/schema/pull-requests";
import { stackBriefs } from "../../db/schema/stack-briefs";
import { walkthroughIssues } from "../../db/schema/walkthrough-issues";
import { walkthroughs } from "../../db/schema/walkthroughs";
import {
  DbError,
  type GitHubError,
  GitHubNetworkError,
  GitHubNotFoundError,
  GitHubRateLimitError,
} from "../../domain/errors";
import { withDb } from "../../effects/with-db";
import { logError } from "../../logger";
import { withGitHubOrigin } from "../../observability/github-ledger/origin";
import { Broadcaster } from "../Broadcaster";
import { CacheService } from "../Cache";
import { DbService } from "../Db";
import { readCurrentHeadFiles } from "../DiffCache";
import { githubGraphql, githubGraphqlPartial, withSchemaFallback } from "../github-rest";
import { type PrContextBasic, type PrContextError, PrContextService } from "../PrContext";
import { fingerprintFiles, stackSignature } from "./fingerprint";
import {
  type GitHubStack,
  layersToCompare,
  type MirroredLayer,
  mapGitHubStack,
  membershipSupersededByPoll,
  stackFromMirror,
  withBehind,
} from "./map";
import {
  overlayStack,
  type RevvStackFacts,
  type TrackedLayer,
  type WalkthroughFact,
} from "./overlay";
import {
  layerCompareQuery,
  PR_STACK_QUERY,
  type RawLayerCompareAnswer,
  type RawPrStackAnswer,
  STACK_SCHEMA_TOKENS,
} from "./queries";
import { isCompleteReview, readBriefLayers } from "./reads";

const CACHE_NS = "pr-stack";
const FRESH_FOR_MS = 30_000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export type StackError = GitHubError | PrContextError | DbError;

const cacheKey = (repositoryId: string, stackNumber: number) => `${repositoryId}:${stackNumber}`;

export class StackService extends Context.Tag("StackService")<
  StackService,
  {
    /**
     * The PR's stack with Revv's overlay, or null when the PR isn't stacked
     * (or the host predates stacks). Serves a read under 30s old from the
     * cache, and the last good one (`stale: true`) when GitHub is unreachable.
     */
    readonly detail: (
      prId: string,
      userId: string,
      accountId?: string,
    ) => Effect.Effect<PrStackDetail | null, StackError>;
    readonly fetchFresh: (ctx: PrContextBasic) => Effect.Effect<GitHubStack | null, StackError>;
    readonly snapshot: (ctx: PrContextBasic) => Effect.Effect<WalkthroughStackSnapshot | null>;
    readonly markStale: (repositoryId: string, stackNumber: number) => Effect.Effect<void, DbError>;
  }
>() {}

function repoRef(ctx: PrContextBasic) {
  const [owner, repo, ...rest] = ctx.repo.fullName.split("/");
  return owner && repo && rest.length === 0
    ? Effect.succeed({ owner, repo })
    : Effect.fail(new GitHubNotFoundError({ resource: "repo", id: ctx.repo.fullName }));
}

function isUnreachable(e: unknown): boolean {
  return e instanceof GitHubNetworkError || e instanceof GitHubRateLimitError;
}

function askStack(ctx: PrContextBasic) {
  return Effect.gen(function* () {
    const ref = yield* repoRef(ctx);
    const { value, modern } = yield* withSchemaFallback(
      (modern) =>
        modern
          ? githubGraphql<RawPrStackAnswer>(
              PR_STACK_QUERY,
              { ...ref, number: ctx.pr.externalId },
              ctx.token,
              ctx.apiBase,
            )
          : Effect.succeed<RawPrStackAnswer>({ repository: null }),
      STACK_SCHEMA_TOKENS,
    );
    const stack = modern ? mapGitHubStack(value, new Date().toISOString()) : null;
    return stack ? yield* withLayerBehind(ctx, ref, stack) : null;
  });
}

function withLayerBehind(
  ctx: PrContextBasic,
  ref: { owner: string; repo: string },
  stack: GitHubStack,
) {
  const layers = layersToCompare(stack);
  if (layers.length === 0) return Effect.succeed(stack);
  const { query, variables } = layerCompareQuery(layers);
  return githubGraphqlPartial<RawLayerCompareAnswer>(
    query,
    { ...ref, ...variables },
    ctx.token,
    ctx.apiBase,
  ).pipe(
    Effect.map((answer) => withBehind(stack, answer)),
    Effect.catchAll((err) =>
      Effect.sync(() => {
        logError("stacks", `comparing stack #${stack.number}'s layers failed`, err);
        return stack;
      }),
    ),
  );
}

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
  repositoryId: string,
  stack: GitHubStack,
): Effect.Effect<RevvStackFacts, DbError, DbService> {
  return Effect.gen(function* () {
    const { db } = yield* DbService;
    return yield* Effect.try({
      try: (): RevvStackFacts => {
        const numbers = stack.layers.map((l) => l.number);
        const prRows = db
          .select({
            id: pullRequests.id,
            externalId: pullRequests.externalId,
            headSha: pullRequests.headSha,
          })
          .from(pullRequests)
          .where(
            and(
              eq(pullRequests.repositoryId, repositoryId),
              inArray(pullRequests.externalId, numbers),
            ),
          )
          .all();
        const prIds = prRows.map((r) => r.id);

        const wtRows =
          prIds.length === 0
            ? []
            : db
                .select({
                  id: walkthroughs.id,
                  prId: walkthroughs.pullRequestId,
                  status: walkthroughs.status,
                  phase: walkthroughs.lastCompletedPhase,
                  completedAt: walkthroughs.completedAt,
                  prHeadSha: walkthroughs.prHeadSha,
                  riskLevel: walkthroughs.riskLevel,
                  summary: walkthroughs.summary,
                  stackContext: walkthroughs.stackContext,
                  diffFingerprint: walkthroughs.diffFingerprint,
                  carriedFrom: walkthroughs.carriedFromWalkthroughId,
                })
                .from(walkthroughs)
                .where(inArray(walkthroughs.pullRequestId, prIds))
                .orderBy(desc(walkthroughs.generatedAt))
                .all();

        const wtIds = wtRows.map((w) => w.id);
        const issueCounts = new Map<string, { open: number; critical: number }>();
        if (wtIds.length > 0) {
          const counts = db
            .select({
              walkthroughId: walkthroughIssues.walkthroughId,
              open: sql<number>`count(*)`,
              critical: sql<number>`sum(case when ${walkthroughIssues.severity} = 'critical' then 1 else 0 end)`,
            })
            .from(walkthroughIssues)
            .where(
              and(
                inArray(walkthroughIssues.walkthroughId, wtIds),
                eq(walkthroughIssues.resolutionStatus, "open"),
              ),
            )
            .groupBy(walkthroughIssues.walkthroughId)
            .all();
          for (const c of counts) {
            issueCounts.set(c.walkthroughId, { open: c.open, critical: c.critical ?? 0 });
          }
        }

        const filesByPr = readCurrentHeadFiles(db, prIds);

        const toFact = (w: (typeof wtRows)[number]): WalkthroughFact => {
          const counts = issueCounts.get(w.id);
          return {
            id: w.id,
            status: w.status,
            prHeadSha: w.prHeadSha,
            riskLevel: (w.riskLevel as RiskLevel | null) ?? null,
            summary: w.summary,
            openIssues: counts?.open ?? 0,
            criticalIssues: counts?.critical ?? 0,
            stackContext: w.stackContext,
            fingerprint: w.diffFingerprint,
            carried: w.carriedFrom !== null,
          };
        };

        const tracked = new Map<number, TrackedLayer>();
        for (const pr of prRows) {
          const rows = wtRows.filter((w) => w.prId === pr.id);
          const current = rows.find((w) => w.status !== "superseded" && w.prHeadSha === pr.headSha);
          const latestComplete = rows.find(isCompleteReview);
          const files = filesByPr.get(pr.id);
          tracked.set(pr.externalId, {
            prId: pr.id,
            currentFingerprint: files
              ? fingerprintFiles(
                  files.map((f) => ({ filename: f.path, status: f.status, patch: f.patch })),
                )
              : null,
            files: files ? files.map((f) => f.path) : null,
            current: current ? toFact(current) : null,
            latestComplete: latestComplete ? toFact(latestComplete) : null,
          });
        }

        return {
          repositoryId,
          tracked,
          brief: readBrief(db, repositoryId, stack),
        };
      },
      catch: (cause) => new DbError({ message: "stack facts read failed", cause }),
    });
  });
}

function readMirror(
  repositoryId: string,
  stackNumber: number,
): Effect.Effect<MirroredLayer[], DbError, DbService> {
  return Effect.gen(function* () {
    const { db } = yield* DbService;
    return yield* Effect.try({
      try: () =>
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
      catch: (cause) => new DbError({ message: "stack mirror read failed", cause }),
    });
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

type Db = DbService["Type"]["db"];

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
    const cache = yield* CacheService;
    const broadcaster = yield* Broadcaster;
    const revalidating = new Set<string>();

    const fetchFresh = (ctx: PrContextBasic) =>
      Effect.gen(function* () {
        const stack = yield* askStack(ctx);
        if (stack) {
          yield* withDb(
            db,
            cache.set(CACHE_NS, cacheKey(ctx.repo.id, stack.number), stack, {
              ttlMs: CACHE_TTL_MS,
            }),
          );
        }
        return stack;
      });

    const revalidate = (ctx: PrContextBasic, stackNumber: number, accountId: string) => {
      const key = cacheKey(ctx.repo.id, stackNumber);
      if (revalidating.has(key)) return Effect.void;
      revalidating.add(key);
      return fetchFresh(ctx).pipe(
        Effect.flatMap((stack) =>
          stack
            ? broadcaster.broadcastToAccount(accountId, {
                type: "stack:updated",
                data: { repositoryId: ctx.repo.id, stackNumber: stack.number },
              })
            : Effect.void,
        ),
        Effect.catchAllCause((cause) =>
          Effect.sync(() => logError("stacks", `background re-read of ${key} failed`, cause)),
        ),
        Effect.ensuring(Effect.sync(() => revalidating.delete(key))),
        withGitHubOrigin("stack:revalidate"),
        Effect.forkDaemon,
        Effect.asVoid,
      );
    };

    const githubStack = (
      ctx: PrContextBasic,
      stackNumber: number,
      revalidateFor: string | null = null,
    ) =>
      Effect.gen(function* () {
        const mirror = yield* withDb(db, readMirror(ctx.repo.id, stackNumber));
        const cached = yield* withDb(
          db,
          cache.get<GitHubStack>(CACHE_NS, cacheKey(ctx.repo.id, stackNumber)),
        );
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
            return yield* fetchFresh(ctx).pipe(
              Effect.map((stack) => ({ stack, stale: false })),
              Effect.catchIf(isUnreachable, (err) =>
                ifUnreachable
                  ? Effect.succeed({ stack: ifUnreachable, stale: true })
                  : Effect.fail(err),
              ),
            );
          }
        }
      });

    const detail = (prId: string, userId: string, accountId?: string) =>
      Effect.gen(function* () {
        const ctx = yield* withDb(db, prContext.resolveBasic(prId, userId, accountId));
        if (!ctx.pr.stack) return null;
        const { stack, stale } = yield* githubStack(ctx, ctx.pr.stack.number, accountId ?? null);
        if (!stack) return null;
        const facts = yield* withDb(db, readStackFacts(ctx.repo.id, stack));
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
        Effect.catchAll((err) =>
          Effect.sync(() => {
            logError("stacks", `stack snapshot for ${ctx.pr.id} failed`, err);
            return null;
          }),
        ),
      );

    const markStale = (repositoryId: string, stackNumber: number) =>
      Effect.gen(function* () {
        const key = cacheKey(repositoryId, stackNumber);
        const cached = yield* cache.get<GitHubStack>(CACHE_NS, key);
        if (!cached) return;
        const aged: GitHubStack = { ...cached, fetchedAt: new Date(0).toISOString() };
        yield* cache.set(CACHE_NS, key, aged, { ttlMs: CACHE_TTL_MS });
      }).pipe((eff) => withDb(db, eff));

    return { detail, fetchFresh, snapshot, markStale };
  }),
);
