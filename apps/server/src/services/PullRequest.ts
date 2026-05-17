import type { PullRequest } from "@revv/shared";
import { and, desc, eq, gte, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { pullRequests, repositories, walkthroughs } from "../db/schema/index";
import { NotFoundError, ValidationError } from "../domain/errors";
import { DbService } from "./Db";

function rowToPr(row: typeof pullRequests.$inferSelect): PullRequest {
  return {
    id: row.id,
    externalId: row.externalId,
    repositoryId: row.repositoryId,
    title: row.title,
    body: row.body ?? null,
    authorLogin: row.authorLogin,
    authorAvatarUrl: row.authorAvatarUrl ?? null,
    requestedReviewers: JSON.parse(row.requestedReviewers ?? "[]") as string[],
    status: row.status as PullRequest["status"],
    reviewStatus: row.reviewStatus as PullRequest["reviewStatus"],
    isDraft: row.isDraft,
    sourceBranch: row.sourceBranch,
    targetBranch: row.targetBranch,
    url: row.url,
    additions: row.additions,
    deletions: row.deletions,
    changedFiles: row.changedFiles,
    headSha: row.headSha ?? null,
    baseSha: row.baseSha ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    fetchedAt: row.fetchedAt,
    closedAt: row.closedAt ?? null,
  };
}

/**
 * Query shape for the windowed archive read path. All fields optional:
 *   - no `repoId` → all repos
 *   - no `since` / `until` → unbounded period
 *   - no `cursor` → first page
 *   - no `limit` → server default
 */
export interface ListArchivedPrsParams {
  readonly repoId?: string;
  /** Inclusive lower bound on `closedAt` (ISO). */
  readonly since?: string;
  /** Exclusive upper bound on `closedAt` (ISO). */
  readonly until?: string;
  /** Cursor: the `closedAt` of the last row from the previous page. */
  readonly cursor?: string;
  /** Page size. Clamped to `[1, MAX_ARCHIVE_PAGE_LIMIT]`. */
  readonly limit?: number;
}

export interface ListArchivedPrsResult {
  readonly prs: ReadonlyArray<PullRequest>;
  /** `closedAt` cursor to pass back for the next page, or null if exhausted. */
  readonly nextCursor: string | null;
}

/**
 * Lightweight projection of a "latest complete, non-superseded" walkthrough
 * for a PR, used by the recap pipeline's window query. The full walkthrough
 * (blocks / ratings / issues) is fetched by the recap MCP read tool on
 * demand — this shape keeps the windowed query fast and bounded.
 */
export interface ArchivedPrWalkthroughSummary {
  readonly id: string;
  readonly summary: string;
  readonly sentiment: string | null;
  readonly riskLevel: string;
  readonly completedAt: string | null;
}

export interface ArchivedPrWithWalkthrough {
  readonly pr: PullRequest;
  readonly walkthrough: ArchivedPrWalkthroughSummary | null;
}

/** Default page size for `listArchivedPrs` when caller doesn't specify. */
export const DEFAULT_ARCHIVE_PAGE_LIMIT = 50;
/** Upper bound on `listArchivedPrs` page size — defends against pathologically large pulls. */
export const MAX_ARCHIVE_PAGE_LIMIT = 500;

export class PullRequestService extends Context.Tag("PullRequestService")<
  PullRequestService,
  {
    readonly listPrs: (
      accountId?: string,
      repoId?: string,
    ) => Effect.Effect<PullRequest[], never, DbService>;
    readonly getPr: (
      id: string,
      accountId?: string,
    ) => Effect.Effect<PullRequest, NotFoundError, DbService>;
    readonly upsertPrs: (prs: PullRequest[]) => Effect.Effect<void, ValidationError, DbService>;
    readonly deletePrs: (ids: string[]) => Effect.Effect<void, ValidationError, DbService>;
    /**
     * Windowed read of archived (closed/merged) PRs. Supports:
     *   - per-repo filtering for the sidebar / recap pipeline
     *   - inclusive/exclusive period bounds for the recap scheduler
     *   - cursor pagination for the sidebar's "show more" affordance
     * No hard cap on result-set size (replaces the legacy LIMIT 20).
     * Ordered by `closedAt DESC` so newest archives come first.
     */
    readonly listArchivedPrs: (
      accountId?: string,
      params?: ListArchivedPrsParams,
    ) => Effect.Effect<ListArchivedPrsResult, ValidationError, DbService>;
    /**
     * Per-window read used by the recap pipeline. Returns every archived PR
     * for the repo whose `closedAt` falls in `[since, until)`, joined to the
     * latest non-superseded complete walkthrough (if any). Unpaginated by
     * design — daily/weekly windows are bounded by time, not by row count,
     * and the agent's MCP read tool needs the whole set to produce a recap.
     */
    readonly listArchivedPrsForWindow: (
      repoId: string,
      since: string,
      until: string,
      accountId?: string,
    ) => Effect.Effect<ReadonlyArray<ArchivedPrWithWalkthrough>, ValidationError, DbService>;
    /**
     * Currently open PRs for a repo, joined to their latest non-superseded
     * complete walkthrough (if any). Used by the recap agent to surface
     * "who is working on what" context. Sorted by walkthrough presence then
     * updatedAt DESC. Capped at 20 rows to keep the context window bounded.
     */
    readonly listOpenPrsWithWalkthroughs: (
      repoId: string,
      accountId?: string,
    ) => Effect.Effect<ReadonlyArray<ArchivedPrWithWalkthrough>, ValidationError, DbService>;
    readonly markPrsClosed: (
      updates: Array<{ id: string; status: "closed" | "merged"; closedAt: string }>,
    ) => Effect.Effect<void, ValidationError, DbService>;
    /**
     * Read the high-water-mark for review-comment sync. Used as the `?since=`
     * parameter on the next poll so we don't re-download comments we've
     * already ingested. Null on a cache cold-start.
     */
    readonly getCommentsSyncedAt: (prId: string) => Effect.Effect<string | null, never, DbService>;
    /** Persist the watermark after a successful sync. */
    readonly setCommentsSyncedAt: (
      prId: string,
      timestamp: string,
    ) => Effect.Effect<void, never, DbService>;
    /**
     * Read the GraphQL-thread fingerprint for a PR. Used to skip redundant
     * downstream DB writes and WS events when nothing changed on GitHub.
     * Null = fingerprint has never been computed for this PR.
     */
    readonly getThreadsFingerprint: (
      prId: string,
    ) => Effect.Effect<string | null, never, DbService>;
    /** Store a new threads fingerprint after each GraphQL pull. */
    readonly setThreadsFingerprint: (
      prId: string,
      fingerprint: string,
    ) => Effect.Effect<void, never, DbService>;
  }
>() {}

export const PullRequestServiceLive = Layer.succeed(PullRequestService, {
  listPrs: (accountId, repoId) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;

      const repoIds = accountId
        ? db
            .select({ id: repositories.id })
            .from(repositories)
            .where(eq(repositories.accountId, accountId))
            .all()
            .map((r) => r.id)
        : null;

      if (accountId && repoIds !== null && repoIds.length === 0) return [];

      const rows = yield* Effect.try({
        try: () => {
          const conditions: (ReturnType<typeof eq> | ReturnType<typeof inArray>)[] = [
            eq(pullRequests.status, "open"),
          ];
          if (repoIds && repoIds.length > 0) {
            conditions.push(inArray(pullRequests.repositoryId, repoIds));
          }
          if (repoId) conditions.push(eq(pullRequests.repositoryId, repoId));
          return db
            .select()
            .from(pullRequests)
            .where(and(...conditions))
            .all();
        },
        catch: (e) => new ValidationError({ message: String(e) }),
      }).pipe(Effect.orElseSucceed(() => [] as (typeof pullRequests.$inferSelect)[]));
      return rows.map(rowToPr);
    }),

  getPr: (id, accountId) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      const row = yield* Effect.try({
        try: () => db.select().from(pullRequests).where(eq(pullRequests.id, id)).get(),
        catch: (e) => new ValidationError({ message: String(e) }),
      }).pipe(
        Effect.catchAll(() => Effect.succeed(null as typeof pullRequests.$inferSelect | null)),
      );
      if (!row) {
        return yield* Effect.fail(new NotFoundError({ resource: "pull_request", id }));
      }
      // When accountId is supplied (API routes), verify ownership through the repository.
      if (accountId) {
        const repo = db
          .select()
          .from(repositories)
          .where(eq(repositories.id, row.repositoryId))
          .get();
        if (!repo || repo.accountId !== accountId) {
          return yield* Effect.fail(new NotFoundError({ resource: "pull_request", id }));
        }
      }
      return rowToPr(row);
    }),

  upsertPrs: (prs) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      if (prs.length === 0) return;
      yield* Effect.tryPromise({
        try: () => {
          const values = prs.map((pr) => {
            const base: typeof pullRequests.$inferInsert = {
              id: pr.id,
              externalId: pr.externalId,
              repositoryId: pr.repositoryId,
              title: pr.title,
              authorLogin: pr.authorLogin,
              status: pr.status,
              reviewStatus: pr.reviewStatus,
              isDraft: pr.isDraft,
              sourceBranch: pr.sourceBranch,
              targetBranch: pr.targetBranch,
              url: pr.url,
              additions: pr.additions,
              deletions: pr.deletions,
              changedFiles: pr.changedFiles,
              createdAt: pr.createdAt,
              updatedAt: pr.updatedAt,
              fetchedAt: pr.fetchedAt,
              requestedReviewers: JSON.stringify(pr.requestedReviewers ?? []),
            };
            // Only set optional fields when non-null to satisfy exactOptionalPropertyTypes
            if (pr.body !== null) base.body = pr.body;
            if (pr.authorAvatarUrl !== null) base.authorAvatarUrl = pr.authorAvatarUrl;
            if (pr.headSha !== null) base.headSha = pr.headSha;
            if (pr.baseSha !== null) base.baseSha = pr.baseSha;
            if (pr.closedAt !== null) base.closedAt = pr.closedAt;
            return base;
          });
          return Promise.resolve(
            db
              .insert(pullRequests)
              .values(values)
              .onConflictDoUpdate({
                target: pullRequests.id,
                // Drizzle expands a bare column reference like
                // `pullRequests.headSha` to `head_sha = head_sha`
                // — a no-op self-assignment. We need the EXCLUDED
                // (newly-supplied) value, so every column the poll
                // is meant to refresh has to go through
                // `sql\`excluded.<col>\`` explicitly. Without this
                // the row never moves past its initial-insert state,
                // PollScheduler's existingShaMap-vs-fresh comparison
                // fires `supersedeForPr` on every cycle, and an
                // in-flight walkthrough at the latest SHA gets
                // cancelled the next time the poll ticks.
                set: {
                  title: sql`excluded.title`,
                  body: sql`excluded.body`,
                  status: sql`excluded.status`,
                  isDraft: sql`excluded.is_draft`,
                  additions: sql`excluded.additions`,
                  deletions: sql`excluded.deletions`,
                  changedFiles: sql`excluded.changed_files`,
                  headSha: sql`excluded.head_sha`,
                  baseSha: sql`excluded.base_sha`,
                  updatedAt: sql`excluded.updated_at`,
                  fetchedAt: sql`excluded.fetched_at`,
                  requestedReviewers: sql`excluded.requested_reviewers`,
                  closedAt: sql`excluded.closed_at`,
                },
              })
              .run(),
          );
        },
        catch: (e) => new ValidationError({ message: String(e) }),
      });
    }),

  deletePrs: (ids) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      if (ids.length === 0) return;
      yield* Effect.tryPromise({
        try: () =>
          Promise.resolve(db.delete(pullRequests).where(inArray(pullRequests.id, ids)).run()),
        catch: (e) => new ValidationError({ message: String(e) }),
      });
    }),

  listArchivedPrs: (accountId, params) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      const limit = Math.min(
        Math.max(1, params?.limit ?? DEFAULT_ARCHIVE_PAGE_LIMIT),
        MAX_ARCHIVE_PAGE_LIMIT,
      );

      const repoIds = accountId
        ? db
            .select({ id: repositories.id })
            .from(repositories)
            .where(eq(repositories.accountId, accountId))
            .all()
            .map((r) => r.id)
        : null;

      if (accountId && (!repoIds || repoIds.length === 0)) {
        return { prs: [], nextCursor: null };
      }

      return yield* Effect.try({
        try: () => {
          const conditions: (
            | ReturnType<typeof eq>
            | ReturnType<typeof ne>
            | ReturnType<typeof gte>
            | ReturnType<typeof lt>
            | ReturnType<typeof inArray>
          )[] = [ne(pullRequests.status, "open")];
          if (repoIds && repoIds.length > 0) {
            conditions.push(inArray(pullRequests.repositoryId, repoIds));
          }
          if (params?.repoId !== undefined) {
            conditions.push(eq(pullRequests.repositoryId, params.repoId));
          }
          if (params?.since !== undefined) {
            conditions.push(gte(pullRequests.closedAt, params.since));
          }
          if (params?.until !== undefined) {
            conditions.push(lt(pullRequests.closedAt, params.until));
          }
          if (params?.cursor !== undefined) {
            // Cursor is the closedAt of the last row from the prior page.
            // Strict `<` so the cursor row itself is not redelivered.
            conditions.push(lt(pullRequests.closedAt, params.cursor));
          }

          // Probe with limit + 1 so we can detect whether more rows exist
          // without a separate COUNT query.
          const rows = db
            .select()
            .from(pullRequests)
            .where(and(...conditions))
            .orderBy(desc(pullRequests.closedAt))
            .limit(limit + 1)
            .all();

          const hasMore = rows.length > limit;
          const trimmed = hasMore ? rows.slice(0, limit) : rows;
          const lastRow = trimmed[trimmed.length - 1];
          const nextCursor = hasMore && lastRow ? (lastRow.closedAt ?? null) : null;

          return {
            prs: trimmed.map(rowToPr),
            nextCursor,
          };
        },
        catch: (e) => new ValidationError({ message: String(e) }),
      });
    }),

  listArchivedPrsForWindow: (repoId, since, until, accountId) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      // When accountId is supplied (API routes), verify the repo belongs to it.
      if (accountId) {
        const repo = db.select().from(repositories).where(eq(repositories.id, repoId)).get();
        if (!repo || repo.accountId !== accountId) {
          return [] as ReadonlyArray<ArchivedPrWithWalkthrough>;
        }
      }
      return yield* Effect.try({
        try: () => {
          const prRows = db
            .select()
            .from(pullRequests)
            .where(
              and(
                eq(pullRequests.repositoryId, repoId),
                ne(pullRequests.status, "open"),
                gte(pullRequests.closedAt, since),
                lt(pullRequests.closedAt, until),
              ),
            )
            .orderBy(desc(pullRequests.closedAt))
            .all();

          if (prRows.length === 0) {
            return [] as ReadonlyArray<ArchivedPrWithWalkthrough>;
          }

          const prIds = prRows.map((r) => r.id);

          // Latest non-superseded complete walkthrough per PR. We pull all
          // candidates and pick the freshest in JS — SQLite's window
          // functions work but are clunkier than the JS path for a list
          // bounded by the period (usually ≤ a few dozen PRs).
          const wtRows = db
            .select({
              id: walkthroughs.id,
              pullRequestId: walkthroughs.pullRequestId,
              summary: walkthroughs.summary,
              sentiment: walkthroughs.sentiment,
              riskLevel: walkthroughs.riskLevel,
              completedAt: walkthroughs.completedAt,
              generatedAt: walkthroughs.generatedAt,
            })
            .from(walkthroughs)
            .where(
              and(
                inArray(walkthroughs.pullRequestId, prIds),
                eq(walkthroughs.status, "complete"),
                isNull(walkthroughs.supersededBy),
              ),
            )
            .all();

          const latestByPr = new Map<string, (typeof wtRows)[number]>();
          for (const w of wtRows) {
            const current = latestByPr.get(w.pullRequestId);
            if (!current) {
              latestByPr.set(w.pullRequestId, w);
              continue;
            }
            // Prefer the larger completedAt; fall back to generatedAt for
            // pre-migration rows whose completedAt is still null (the
            // 0220 backfill should cover all of these, but defend anyway).
            const curTs = current.completedAt ?? current.generatedAt;
            const newTs = w.completedAt ?? w.generatedAt;
            if (newTs > curTs) latestByPr.set(w.pullRequestId, w);
          }

          return prRows.map((pr): ArchivedPrWithWalkthrough => {
            const w = latestByPr.get(pr.id);
            return {
              pr: rowToPr(pr),
              walkthrough: w
                ? {
                    id: w.id,
                    summary: w.summary,
                    sentiment: w.sentiment ?? null,
                    riskLevel: w.riskLevel,
                    completedAt: w.completedAt ?? null,
                  }
                : null,
            };
          });
        },
        catch: (e) => new ValidationError({ message: String(e) }),
      });
    }),

  listOpenPrsWithWalkthroughs: (repoId, accountId) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      if (accountId) {
        const repo = db.select().from(repositories).where(eq(repositories.id, repoId)).get();
        if (!repo || repo.accountId !== accountId) {
          return [] as ReadonlyArray<ArchivedPrWithWalkthrough>;
        }
      }
      return yield* Effect.try({
        try: () => {
          const prRows = db
            .select()
            .from(pullRequests)
            .where(and(eq(pullRequests.repositoryId, repoId), eq(pullRequests.status, "open")))
            .orderBy(desc(pullRequests.updatedAt))
            .limit(20)
            .all();

          if (prRows.length === 0) {
            return [] as ReadonlyArray<ArchivedPrWithWalkthrough>;
          }

          const prIds = prRows.map((r) => r.id);

          const wtRows = db
            .select({
              id: walkthroughs.id,
              pullRequestId: walkthroughs.pullRequestId,
              summary: walkthroughs.summary,
              sentiment: walkthroughs.sentiment,
              riskLevel: walkthroughs.riskLevel,
              completedAt: walkthroughs.completedAt,
              generatedAt: walkthroughs.generatedAt,
            })
            .from(walkthroughs)
            .where(
              and(
                inArray(walkthroughs.pullRequestId, prIds),
                eq(walkthroughs.status, "complete"),
                isNull(walkthroughs.supersededBy),
              ),
            )
            .all();

          const latestByPr = new Map<string, (typeof wtRows)[number]>();
          for (const w of wtRows) {
            const current = latestByPr.get(w.pullRequestId);
            if (!current) {
              latestByPr.set(w.pullRequestId, w);
              continue;
            }
            const curTs = current.completedAt ?? current.generatedAt;
            const newTs = w.completedAt ?? w.generatedAt;
            if (newTs > curTs) latestByPr.set(w.pullRequestId, w);
          }

          // Sort: PRs with walkthroughs first, then by updatedAt DESC
          const withWt = prRows.filter((pr) => latestByPr.has(pr.id));
          const withoutWt = prRows.filter((pr) => !latestByPr.has(pr.id));
          const sorted = [...withWt, ...withoutWt];

          return sorted.map((pr): ArchivedPrWithWalkthrough => {
            const w = latestByPr.get(pr.id);
            return {
              pr: rowToPr(pr),
              walkthrough: w
                ? {
                    id: w.id,
                    summary: w.summary,
                    sentiment: w.sentiment ?? null,
                    riskLevel: w.riskLevel,
                    completedAt: w.completedAt ?? null,
                  }
                : null,
            };
          });
        },
        catch: (e) => new ValidationError({ message: String(e) }),
      });
    }),

  markPrsClosed: (updates) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      if (updates.length === 0) return;
      yield* Effect.tryPromise({
        try: () => {
          const fetchedAt = new Date().toISOString();
          for (const { id, status, closedAt } of updates) {
            db.update(pullRequests)
              .set({ status, closedAt, fetchedAt })
              .where(eq(pullRequests.id, id))
              .run();
          }
          return Promise.resolve();
        },
        catch: (e) => new ValidationError({ message: String(e) }),
      });
    }),

  // ── Watermark methods: sync helpers used by SyncService. Wrap the
  // Drizzle calls in Effect.try so a SQLite throw surfaces as a typed
  // failure (caught locally) rather than an Effect defect that would
  // crash the calling fiber. The error channel stays `never` from the
  // caller's perspective via the trailing catchAll.

  getCommentsSyncedAt: (prId) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      const row = yield* Effect.try({
        try: () =>
          db
            .select({ ts: pullRequests.commentsSyncedAt })
            .from(pullRequests)
            .where(eq(pullRequests.id, prId))
            .get(),
        catch: (e) => new ValidationError({ message: String(e) }),
      });
      return row?.ts ?? null;
    }).pipe(Effect.catchAll(() => Effect.succeed(null))),

  setCommentsSyncedAt: (prId, timestamp) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      yield* Effect.try({
        try: () =>
          db
            .update(pullRequests)
            .set({ commentsSyncedAt: timestamp })
            .where(eq(pullRequests.id, prId))
            .run(),
        catch: (e) => new ValidationError({ message: String(e) }),
      });
    }).pipe(Effect.catchAll(() => Effect.void)),

  getThreadsFingerprint: (prId) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      const row = yield* Effect.try({
        try: () =>
          db
            .select({ fp: pullRequests.threadsFingerprint })
            .from(pullRequests)
            .where(eq(pullRequests.id, prId))
            .get(),
        catch: (e) => new ValidationError({ message: String(e) }),
      });
      return row?.fp ?? null;
    }).pipe(Effect.catchAll(() => Effect.succeed(null))),

  setThreadsFingerprint: (prId, fingerprint) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      yield* Effect.try({
        try: () =>
          db
            .update(pullRequests)
            .set({ threadsFingerprint: fingerprint })
            .where(eq(pullRequests.id, prId))
            .run(),
        catch: (e) => new ValidationError({ message: String(e) }),
      });
    }).pipe(Effect.catchAll(() => Effect.void)),
});
