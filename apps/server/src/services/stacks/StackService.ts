// ── Stack service ───────────────────────────────────────────────────────────
//
// One PR's GitHub stack, joined with what Revv knows about each layer. The
// GitHub half is one GraphQL read kept briefly in the kv cache (the poll
// drops it when a member moves); the Revv half is read from the DB on every
// call, so a walkthrough landing shows up without invalidating anything.
// Nothing here is journaled: losing the cache costs one fetch.

import type {
  PrStackDetail,
  RiskLevel,
  StackBrief,
  StackBriefStatus,
  StackLayerLink,
  WalkthroughStackSnapshot,
} from "@revv/shared";
import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { prDiffFiles } from "../../db/schema/pr-diff-files";
import { pullRequests } from "../../db/schema/pull-requests";
import { stackBriefLayers, stackBriefs } from "../../db/schema/stack-briefs";
import { walkthroughIssues } from "../../db/schema/walkthrough-issues";
import { walkthroughs } from "../../db/schema/walkthroughs";
import {
  DbError,
  type GitHubError,
  GitHubNetworkError,
  GitHubNotFoundError,
  GitHubRateLimitError,
} from "../../domain/errors";
import { logError } from "../../logger";
import { withGitHubOrigin } from "../../observability/github-ledger/origin";
import { Broadcaster } from "../Broadcaster";
import { CacheService } from "../Cache";
import { DbService } from "../Db";
import { githubGraphql, githubGraphqlPartial, withSchemaFallback } from "../github-rest";
import { type PrContextBasic, type PrContextError, PrContextService } from "../PrContext";
import { fingerprintFiles, parseFingerprint, stackSignature } from "./fingerprint";
import {
  agreesWithMirror,
  type GitHubStack,
  layersToCompare,
  type MirroredLayer,
  mapGitHubStack,
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

const CACHE_NS = "pr-stack";
/** A read this young is served as is: switching layers mustn't refetch. */
const FRESH_FOR_MS = 30_000;
/** Kept as the fallback when GitHub can't be reached. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export type StackError = GitHubError | PrContextError | DbError;

/** Where a PR's GitHub stack lives in the cache. */
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
    ) => Effect.Effect<PrStackDetail | null, StackError, DbService | CacheService>;
    /** The GitHub half only, always fresh from GitHub (merges, plans). */
    readonly fetchFresh: (
      ctx: PrContextBasic,
    ) => Effect.Effect<GitHubStack | null, StackError, DbService | CacheService>;
    /**
     * The stack as a walkthrough's agent will see it, for the walkthrough
     * row. Never fails: a stack Revv can't read is a walkthrough without one.
     */
    readonly snapshot: (
      ctx: PrContextBasic,
    ) => Effect.Effect<WalkthroughStackSnapshot | null, never, DbService | CacheService>;
    /**
     * Age the cached GitHub read out, after the poll saw a member move: every
     * read re-asks GitHub, but a page can still draw the old one meanwhile.
     */
    readonly invalidate: (
      repositoryId: string,
      stackNumber: number,
    ) => Effect.Effect<void, DbError, DbService>;
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

function parseJson<T>(json: string | null): T | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

/** A host without stacks answers the schema complaint; that's "no stack". */
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

/**
 * Fill in how far each open layer is behind its base. Best-effort: the stack
 * reads the same without it, only the Rebase stack offer goes quiet.
 */
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

// ── Revv's facts ────────────────────────────────────────────────────────────

const TERMINAL_PHASE = "D";

/** Everything the overlay needs from the DB, in five reads. */
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

        // The poll drops a PR's cached files before its new head lands, so
        // whatever `pr_diff_files` holds belongs to the current head.
        const fingerprintable = prRows.filter((r) => r.headSha !== null).map((r) => r.id);
        const filesByPr = new Map<
          string,
          { filename: string; status: string; patch: string | null }[]
        >();
        if (fingerprintable.length > 0) {
          for (const f of db
            .select({
              prId: prDiffFiles.prId,
              path: prDiffFiles.path,
              status: prDiffFiles.status,
              patch: prDiffFiles.patch,
            })
            .from(prDiffFiles)
            .where(inArray(prDiffFiles.prId, fingerprintable))
            .all()) {
            const list = filesByPr.get(f.prId) ?? [];
            list.push({ filename: f.path, status: f.status, patch: f.patch });
            filesByPr.set(f.prId, list);
          }
        }

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
            stackContext: parseJson<WalkthroughStackSnapshot>(w.stackContext),
            fingerprint: parseFingerprint(w.diffFingerprint),
            carried: w.carriedFrom !== null,
          };
        };

        const tracked = new Map<number, TrackedLayer>();
        for (const pr of prRows) {
          const rows = wtRows.filter((w) => w.prId === pr.id);
          const current = rows.find((w) => w.status !== "superseded" && w.prHeadSha === pr.headSha);
          const latestComplete = rows.find(
            (w) => w.phase === TERMINAL_PHASE && w.completedAt !== null && w.status !== "error",
          );
          const files = filesByPr.get(pr.id);
          tracked.set(pr.externalId, {
            prId: pr.id,
            currentFingerprint: files ? fingerprintFiles(files) : null,
            files: files ? files.map((f) => f.filename) : null,
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

/** The poll's rows for one stack: its open layers, and those that landed in it. */
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
  const layers = db
    .select()
    .from(stackBriefLayers)
    .where(eq(stackBriefLayers.briefId, row.id))
    .orderBy(stackBriefLayers.position)
    .all();
  return {
    id: row.id,
    status: row.status as StackBriefStatus,
    stale: row.signature !== stackSignature(stack.layers),
    arc: row.arc,
    reviewOrder: parseJson<number[]>(row.reviewOrder) ?? [],
    layers: layers.map((l) => ({
      position: l.position,
      prNumber: l.prNumber,
      role: l.role,
      reviewFocus: l.reviewFocus,
      chapter: l.chapter,
      buildsOn: parseJson<StackLayerLink[]>(l.buildsOn) ?? [],
    })),
    completedAt: row.completedAt,
  };
}

// ── Live ────────────────────────────────────────────────────────────────────

export const StackServiceLive = Layer.effect(
  StackService,
  Effect.gen(function* () {
    const prContext = yield* PrContextService;
    const cache = yield* CacheService;
    const broadcaster = yield* Broadcaster;
    /** Stacks being re-read in the background; a reconstructible coalescing set. */
    const revalidating = new Set<string>();

    const fetchFresh = (ctx: PrContextBasic) =>
      Effect.gen(function* () {
        const stack = yield* askStack(ctx);
        if (stack) {
          yield* cache.set(CACHE_NS, cacheKey(ctx.repo.id, stack.number), stack, {
            ttlMs: CACHE_TTL_MS,
          });
        }
        return stack;
      });

    /**
     * Re-read a stack from GitHub off the request path, then tell the
     * account's clients, who re-read it. One at a time per stack.
     */
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
        // Nobody waits on it: its GitHub time is background work, not the page's.
        withGitHubOrigin("stack:revalidate"),
        Effect.forkDaemon,
        Effect.asVoid,
      );
    };

    /**
     * The cached read when it's fresh and still agrees with the poll on who is
     * in the stack, else GitHub. When GitHub can't be reached: the cached read
     * if it agrees, else the stack rebuilt from the poll's rows, both marked
     * stale. A cached read that disagrees is never served: after a rebuild it
     * is a different stack, and two layers of one stack would show two.
     *
     * With `revalidateFor` (a page asking, on behalf of that account), an
     * older read that still agrees is answered at once and re-read in the
     * background: its layers' merge states are computed on demand, which
     * costs GitHub seconds on a tall stack, and the page shouldn't wait on
     * them to draw what it already knows.
     */
    const githubStack = (
      ctx: PrContextBasic,
      stackNumber: number,
      revalidateFor: string | null = null,
    ) =>
      Effect.gen(function* () {
        const mirror = yield* readMirror(ctx.repo.id, stackNumber);
        const cached = yield* cache.get<GitHubStack>(CACHE_NS, cacheKey(ctx.repo.id, stackNumber));
        const usable = cached !== null && agreesWithMirror(cached, mirror);
        if (usable && Date.now() - Date.parse(cached.fetchedAt) < FRESH_FOR_MS) {
          return { stack: cached as GitHubStack | null, stale: false };
        }
        if (usable && revalidateFor !== null) {
          yield* revalidate(ctx, stackNumber, revalidateFor);
          return { stack: cached as GitHubStack | null, stale: false };
        }
        return yield* fetchFresh(ctx).pipe(
          Effect.map((stack) => ({ stack, stale: false })),
          Effect.catchIf(isUnreachable, (err) => {
            const fallback = usable
              ? cached
              : stackFromMirror(stackNumber, mirror, new Date().toISOString());
            return fallback
              ? Effect.succeed({ stack: fallback as GitHubStack | null, stale: true })
              : Effect.fail(err);
          }),
        );
      });

    const detail = (prId: string, userId: string, accountId?: string) =>
      Effect.gen(function* () {
        const ctx = yield* prContext.resolveBasic(prId, userId, accountId);
        // The poll's record of membership is the cheap gate: a PR it never
        // saw stacked costs GitHub nothing here.
        if (!ctx.pr.stack) return null;
        const { stack, stale } = yield* githubStack(ctx, ctx.pr.stack.number, accountId ?? null);
        if (!stack) return null;
        const facts = yield* readStackFacts(ctx.repo.id, stack);
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

    const invalidate = (repositoryId: string, stackNumber: number) =>
      Effect.gen(function* () {
        const key = cacheKey(repositoryId, stackNumber);
        const cached = yield* cache.get<GitHubStack>(CACHE_NS, key);
        if (!cached) return;
        const aged: GitHubStack = { ...cached, fetchedAt: new Date(0).toISOString() };
        yield* cache.set(CACHE_NS, key, aged, { ttlMs: CACHE_TTL_MS });
      });

    return { detail, fetchFresh, snapshot, invalidate };
  }),
);
