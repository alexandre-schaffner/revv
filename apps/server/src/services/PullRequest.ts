import type { PullRequest } from "@revv/shared";
import { and, desc, eq, gte, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { pullRequests, repositories, walkthroughs } from "../db/schema/index";
import { avatarOfRepoLogin } from "../db/schema/remote-users";
import { type DbError, NotFoundError } from "../domain/errors";
import type { ObservedPr } from "../domain/observed-pr";
import { dbTry, tryDb } from "../effects/db-try";
import { DbService } from "./Db";
import { extractGitHubMentions } from "./sync-engine/mentions";

function rowToPr(
  row: typeof pullRequests.$inferSelect,
  avatarContent: string | null = null,
): PullRequest {
  return {
    id: row.id,
    externalId: row.externalId,
    repositoryId: row.repositoryId,
    title: row.title,
    body: row.body ?? null,
    authorLogin: row.authorLogin,
    authorAvatarContent: avatarContent,
    authorAvatarUrl: null,
    requestedReviewers: JSON.parse(row.requestedReviewers ?? "[]") as string[],
    mentionedUsers: JSON.parse(row.mentionedUsers ?? "[]") as string[],
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
    stack:
      row.stackNumber !== null && row.stackPosition !== null
        ? { number: row.stackNumber, position: row.stackPosition }
        : null,
  };
}

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
  /**
   * Only PRs authored by these logins; empty or omitted means any author. The
   * sidebar's creator/team filter, so the closed list narrows like the open one.
   */
  readonly authorLogins?: readonly string[];
}

export interface ListArchivedPrsResult {
  readonly prs: ReadonlyArray<PullRequest>;
  /** `closedAt` cursor to pass back for the next page, or null if exhausted. */
  readonly nextCursor: string | null;
}

/**
 * A PR's latest complete, non-superseded walkthrough, for the recap window
 * queries. The recap MCP read tool fetches the full walkthrough on demand.
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

/**
 * `mentioned_users` is the union of the logins mentioned in the PR body
 * (`upsertPrs`) and in review comments (`appendMentionedUsers`), so the only
 * safe write is a merge.
 */
function mergeMentionedUsers(
  db: (typeof DbService)["Service"]["db"],
  prId: string,
  logins: readonly string[],
): void {
  if (logins.length === 0) return;
  const row = db
    .select({ mentionedUsers: pullRequests.mentionedUsers })
    .from(pullRequests)
    .where(eq(pullRequests.id, prId))
    .get();
  if (!row) return;
  const existing = JSON.parse(row.mentionedUsers ?? "[]") as string[];
  const merged = [...new Set([...existing, ...logins])];
  if (merged.length === existing.length) return;
  db.update(pullRequests)
    .set({ mentionedUsers: JSON.stringify(merged) })
    .where(eq(pullRequests.id, prId))
    .run();
}

export const DEFAULT_ARCHIVE_PAGE_LIMIT = 50;
export const MAX_ARCHIVE_PAGE_LIMIT = 500;

export class PullRequestService extends Context.Service<
  PullRequestService,
  {
    readonly listPrs: (
      accountId?: string,
      repoId?: string,
    ) => Effect.Effect<PullRequest[], DbError, DbService>;
    readonly getPr: (
      id: string,
      accountId?: string,
    ) => Effect.Effect<PullRequest, NotFoundError | DbError, DbService>;
    /**
     * Upsert PR rows from GitHub.
     *
     * Three columns are deliberately not assigned from the incoming row:
     *   - `mentioned_users` is merged, never replaced (see
     *     {@link mergeMentionedUsers}).
     *   - `additions` / `deletions` / `changed_files` are only taken when the
     *     source actually carried them. GitHub's list-PRs endpoint returns the
     *     "simple" PR object without those fields, so a poll-sourced row has
     *     zeroes that must not overwrite real numbers. Real stats come from
     *     the poll's separate diff-stat read (`statsHeadSha`), a detail fetch,
     *     or `DiffCacheService.cacheFiles`.
     *   - `stack_number` / `stack_position` are only taken from a row whose
     *     `stack` is `seen` (see `StackSighting`): an `unseen` one leaves the
     *     stored ones be. A fresh insert of an `unseen` row starts unstacked.
     */
    readonly upsertPrs: (prs: readonly ObservedPr[]) => Effect.Effect<void, DbError, DbService>;
    /** The PR numbers mirrored for each repository, open or archived. */
    readonly externalIdsByRepo: (
      repoIds: readonly string[],
    ) => Effect.Effect<Map<string, Set<number>>, DbError, DbService>;
    /** `diff_stats_head_sha` of every PR: the head its stored diff size describes. */
    readonly diffStatsHeads: () => Effect.Effect<Map<string, string | null>, DbError, DbService>;
    /** Closed and merged PRs, newest `closedAt` first, paginated on that cursor. */
    readonly listArchivedPrs: (
      accountId?: string,
      params?: ListArchivedPrsParams,
    ) => Effect.Effect<ListArchivedPrsResult, DbError, DbService>;
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
    ) => Effect.Effect<ReadonlyArray<ArchivedPrWithWalkthrough>, DbError, DbService>;
    /**
     * PRs in flight *as of* `until`: created before the window closed and not
     * yet closed at that instant. Joined to their latest non-superseded
     * complete walkthrough (if any). Used by the recap agent to surface
     * "who is working on what" context. Sorted by walkthrough presence then
     * updatedAt DESC. Capped at 20 rows to keep the context window bounded.
     *
     * For a live window (`until` ≈ now) this is exactly "currently open".
     * For a historical window it reconstructs the set as it stood then, so a
     * recap dated three weeks ago doesn't describe today's open PRs.
     *
     * Residual imprecision, deliberate: the joined walkthrough and the
     * `updatedAt` sort still reflect *current* state. Reconstructing those
     * would need walkthrough version history we don't keep, and "which PRs
     * were in flight" is what the recap prose actually needs.
     */
    readonly listOpenPrsAsOfWindow: (
      repoId: string,
      until: string,
      accountId?: string,
    ) => Effect.Effect<ReadonlyArray<ArchivedPrWithWalkthrough>, DbError, DbService>;
    readonly markPrsClosed: (
      updates: Array<{ id: string; status: "closed" | "merged"; closedAt: string }>,
    ) => Effect.Effect<void, DbError, DbService>;
    readonly setPrDraft: (id: string, isDraft: boolean) => Effect.Effect<void, DbError, DbService>;
    /**
     * The review-comment sync watermark, sent as `?since=` on the next poll.
     * Null before the first sync.
     */
    readonly getCommentsSyncedAt: (
      prId: string,
    ) => Effect.Effect<string | null, DbError, DbService>;
    /** Only after a successful sync. */
    readonly setCommentsSyncedAt: (
      prId: string,
      timestamp: string,
    ) => Effect.Effect<void, DbError, DbService>;
    /**
     * The GraphQL review-thread fingerprint, which lets a pull skip its writes
     * and SSE events when nothing changed on GitHub. Null before the first pull.
     */
    readonly getThreadsFingerprint: (
      prId: string,
    ) => Effect.Effect<string | null, DbError, DbService>;
    readonly setThreadsFingerprint: (
      prId: string,
      fingerprint: string,
    ) => Effect.Effect<void, DbError, DbService>;
    /** Merge @-mentions harvested from review comments into `mentionedUsers`. Idempotent. */
    readonly appendMentionedUsers: (
      prId: string,
      logins: string[],
    ) => Effect.Effect<void, DbError, DbService>;
  }
>()("PullRequestService") {}

export const PullRequestServiceLive = Layer.succeed(PullRequestService, {
  listPrs: (accountId, repoId) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;

      const repoIds = accountId
        ? yield* dbTry("listPrs repos", () =>
            db
              .select({ id: repositories.id })
              .from(repositories)
              .where(eq(repositories.accountId, accountId))
              .all()
              .map((r) => r.id),
          )
        : null;

      if (accountId && repoIds !== null && repoIds.length === 0) return [];

      const rows = yield* dbTry("listPrs", () => {
        const conditions: (ReturnType<typeof eq> | ReturnType<typeof inArray>)[] = [
          eq(pullRequests.status, "open"),
        ];
        if (repoIds && repoIds.length > 0) {
          conditions.push(inArray(pullRequests.repositoryId, repoIds));
        }
        if (repoId) conditions.push(eq(pullRequests.repositoryId, repoId));
        return db
          .select({
            pr: pullRequests,
            avatarContent: avatarOfRepoLogin(pullRequests.authorLogin, pullRequests.repositoryId),
          })
          .from(pullRequests)
          .where(and(...conditions))
          .orderBy(desc(pullRequests.updatedAt))
          .all();
      });
      return rows.map((r) => rowToPr(r.pr, r.avatarContent));
    }),

  getPr: (id, accountId) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      const row = yield* dbTry("getPr", () =>
        db
          .select({
            pr: pullRequests,
            avatarContent: avatarOfRepoLogin(pullRequests.authorLogin, pullRequests.repositoryId),
          })
          .from(pullRequests)
          .where(eq(pullRequests.id, id))
          .get(),
      );
      if (!row) {
        return yield* Effect.fail(new NotFoundError({ resource: "pull_request", id }));
      }
      if (accountId) {
        const repo = yield* dbTry("getPr owner", () =>
          db.select().from(repositories).where(eq(repositories.id, row.pr.repositoryId)).get(),
        );
        if (!repo || repo.accountId !== accountId) {
          return yield* Effect.fail(new NotFoundError({ resource: "pull_request", id }));
        }
      }
      return rowToPr(row.pr, row.avatarContent);
    }),

  upsertPrs: (prs) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      if (prs.length === 0) return;
      const bodyMentionsByPrId = new Map<string, string[]>();
      yield* dbTry("upsertPrs", () => {
        const withStack: (typeof pullRequests.$inferInsert)[] = [];
        const withoutStack: (typeof pullRequests.$inferInsert)[] = [];
        for (const pr of prs) {
          const bodyMentions = pr.body ? extractGitHubMentions(pr.body) : [];
          if (bodyMentions.length > 0) bodyMentionsByPrId.set(pr.id, bodyMentions);
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
            mentionedUsers: JSON.stringify(bodyMentions),
          };
          if (pr.body !== null) base.body = pr.body;
          if (pr.headSha !== null) base.headSha = pr.headSha;
          if (pr.baseSha !== null) base.baseSha = pr.baseSha;
          if (pr.closedAt !== null) base.closedAt = pr.closedAt;
          if (pr.statsHeadSha !== undefined) base.diffStatsHeadSha = pr.statsHeadSha;
          if (pr.stack.kind === "seen" && pr.stack.place) {
            base.stackNumber = pr.stack.place.number;
            base.stackPosition = pr.stack.place.position;
          }
          (pr.stack.kind === "seen" ? withStack : withoutStack).push(base);
        }
        const upsert = (values: (typeof pullRequests.$inferInsert)[], takeStack: boolean) =>
          db
            .insert(pullRequests)
            .values(values)
            .onConflictDoUpdate({
              target: pullRequests.id,
              // Drizzle expands a bare column reference like
              // `pullRequests.headSha` to `head_sha = head_sha`, a no-op.
              // Every refreshed column must read `sql\`excluded.<col>\``,
              // or the stored head never moves and PrMirror sees a head
              // move (and supersedes the walkthrough) on every apply.
              set: {
                title: sql`excluded.title`,
                body: sql`excluded.body`,
                status: sql`excluded.status`,
                isDraft: sql`excluded.is_draft`,
                // Diff stats only when the source carried them (see the
                // `upsertPrs` doc). `changed_files` is the discriminator: any
                // PR with commits has at least one changed file, whereas
                // additions or deletions can legitimately be 0 (pure rename,
                // mode change). `pull_requests.<col>` names the stored row
                // inside SQLite's DO UPDATE.
                additions: sql`CASE WHEN excluded.changed_files > 0 THEN excluded.additions ELSE pull_requests.additions END`,
                deletions: sql`CASE WHEN excluded.changed_files > 0 THEN excluded.deletions ELSE pull_requests.deletions END`,
                changedFiles: sql`CASE WHEN excluded.changed_files > 0 THEN excluded.changed_files ELSE pull_requests.changed_files END`,
                diffStatsHeadSha: sql`COALESCE(excluded.diff_stats_head_sha, pull_requests.diff_stats_head_sha)`,
                headSha: sql`excluded.head_sha`,
                baseSha: sql`excluded.base_sha`,
                updatedAt: sql`excluded.updated_at`,
                fetchedAt: sql`excluded.fetched_at`,
                requestedReviewers: sql`excluded.requested_reviewers`,
                closedAt: sql`excluded.closed_at`,
                // `mentioned_users` is deliberately absent: assigning the
                // body-only set would erase the comment-sourced mentions
                // (see `mergeMentionedUsers`).
                ...(takeStack
                  ? {
                      stackNumber: sql`excluded.stack_number`,
                      stackPosition: sql`excluded.stack_position`,
                    }
                  : {}),
              },
            })
            .run();
        db.transaction(() => {
          if (withStack.length > 0) upsert(withStack, true);
          if (withoutStack.length > 0) upsert(withoutStack, false);
        });
      });

      yield* dbTry("upsertPrs", () => {
        for (const [prId, logins] of bodyMentionsByPrId) {
          mergeMentionedUsers(db, prId, logins);
        }
      });
    }),

  externalIdsByRepo: (repoIds) =>
    repoIds.length === 0
      ? Effect.succeed(new Map())
      : tryDb("read mirrored PR numbers", (db) =>
          db
            .select({
              repositoryId: pullRequests.repositoryId,
              externalId: pullRequests.externalId,
            })
            .from(pullRequests)
            .where(inArray(pullRequests.repositoryId, [...repoIds]))
            .all(),
        ).pipe(
          Effect.map((rows) => {
            const byRepo = new Map<string, Set<number>>();
            for (const row of rows) {
              const set = byRepo.get(row.repositoryId) ?? new Set<number>();
              set.add(row.externalId);
              byRepo.set(row.repositoryId, set);
            }
            return byRepo;
          }),
        ),

  diffStatsHeads: () =>
    tryDb("read PR diff-stat watermarks", (db) =>
      db
        .select({ id: pullRequests.id, headSha: pullRequests.diffStatsHeadSha })
        .from(pullRequests)
        .all(),
    ).pipe(Effect.map((rows) => new Map(rows.map((row) => [row.id, row.headSha])))),

  listArchivedPrs: (accountId, params) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      const limit = Math.min(
        Math.max(1, params?.limit ?? DEFAULT_ARCHIVE_PAGE_LIMIT),
        MAX_ARCHIVE_PAGE_LIMIT,
      );

      const repoIds = accountId
        ? yield* dbTry("listPrs repos", () =>
            db
              .select({ id: repositories.id })
              .from(repositories)
              .where(eq(repositories.accountId, accountId))
              .all()
              .map((r) => r.id),
          )
        : null;

      if (accountId && (!repoIds || repoIds.length === 0)) {
        return { prs: [], nextCursor: null };
      }

      return yield* dbTry("listArchivedPrs", () => {
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
        if (params?.authorLogins && params.authorLogins.length > 0) {
          conditions.push(inArray(pullRequests.authorLogin, [...params.authorLogins]));
        }
        if (params?.since !== undefined) {
          conditions.push(gte(pullRequests.closedAt, params.since));
        }
        if (params?.until !== undefined) {
          conditions.push(lt(pullRequests.closedAt, params.until));
        }
        if (params?.cursor !== undefined) {
          conditions.push(lt(pullRequests.closedAt, params.cursor));
        }

        const rows = db
          .select({
            pr: pullRequests,
            avatarContent: avatarOfRepoLogin(pullRequests.authorLogin, pullRequests.repositoryId),
          })
          .from(pullRequests)
          .where(and(...conditions))
          .orderBy(desc(pullRequests.closedAt))
          .limit(limit + 1)
          .all();

        const hasMore = rows.length > limit;
        const trimmed = hasMore ? rows.slice(0, limit) : rows;
        const lastRow = trimmed[trimmed.length - 1];
        const nextCursor = hasMore && lastRow ? (lastRow.pr.closedAt ?? null) : null;

        return {
          prs: trimmed.map((r) => rowToPr(r.pr, r.avatarContent)),
          nextCursor,
        };
      });
    }),

  listArchivedPrsForWindow: (repoId, since, until, accountId) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      if (accountId) {
        const repo = db.select().from(repositories).where(eq(repositories.id, repoId)).get();
        if (!repo || repo.accountId !== accountId) {
          return [] as ReadonlyArray<ArchivedPrWithWalkthrough>;
        }
      }
      return yield* dbTry("listArchivedPrsForWindow", () => {
        const prRows = db
          .select({
            pr: pullRequests,
            avatarContent: avatarOfRepoLogin(pullRequests.authorLogin, pullRequests.repositoryId),
          })
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

        const prIds = prRows.map((r) => r.pr.id);

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
          // A complete row can still lack `completedAt` if it predates the
          // column; `generatedAt` stands in.
          const curTs = current.completedAt ?? current.generatedAt;
          const newTs = w.completedAt ?? w.generatedAt;
          if (newTs > curTs) latestByPr.set(w.pullRequestId, w);
        }

        return prRows.map((pr): ArchivedPrWithWalkthrough => {
          const w = latestByPr.get(pr.pr.id);
          return {
            pr: rowToPr(pr.pr, pr.avatarContent),
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
      });
    }),

  listOpenPrsAsOfWindow: (repoId, until, accountId) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      if (accountId) {
        const repo = db.select().from(repositories).where(eq(repositories.id, repoId)).get();
        if (!repo || repo.accountId !== accountId) {
          return [] as ReadonlyArray<ArchivedPrWithWalkthrough>;
        }
      }
      return yield* dbTry("listOpenPrsAsOfWindow", () => {
        const prRows = db
          .select({
            pr: pullRequests,
            avatarContent: avatarOfRepoLogin(pullRequests.authorLogin, pullRequests.repositoryId),
          })
          .from(pullRequests)
          .where(
            and(
              eq(pullRequests.repositoryId, repoId),
              // "Open at `until`" reconstructed from timestamps rather than
              // the mutable `status` column, which only ever describes now.
              lt(pullRequests.createdAt, until),
              or(isNull(pullRequests.closedAt), gte(pullRequests.closedAt, until)),
            ),
          )
          .orderBy(desc(pullRequests.updatedAt))
          .limit(20)
          .all();

        if (prRows.length === 0) {
          return [] as ReadonlyArray<ArchivedPrWithWalkthrough>;
        }

        const prIds = prRows.map((r) => r.pr.id);

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

        const withWt = prRows.filter((r) => latestByPr.has(r.pr.id));
        const withoutWt = prRows.filter((r) => !latestByPr.has(r.pr.id));
        const sorted = [...withWt, ...withoutWt];

        return sorted.map((r): ArchivedPrWithWalkthrough => {
          const w = latestByPr.get(r.pr.id);
          return {
            pr: rowToPr(r.pr, r.avatarContent),
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
      });
    }),

  setPrDraft: (id, isDraft) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      yield* dbTry("setPrDraft", () =>
        db.update(pullRequests).set({ isDraft }).where(eq(pullRequests.id, id)).run(),
      );
    }),

  markPrsClosed: (updates) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      if (updates.length === 0) return;
      yield* dbTry("markPrsClosed", () => {
        const fetchedAt = new Date().toISOString();
        for (const { id, status, closedAt } of updates) {
          db.update(pullRequests)
            .set({ status, closedAt, fetchedAt })
            .where(eq(pullRequests.id, id))
            .run();
        }
      });
    }),

  getCommentsSyncedAt: (prId) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      const row = yield* dbTry("getCommentsSyncedAt", () =>
        db
          .select({ ts: pullRequests.commentsSyncedAt })
          .from(pullRequests)
          .where(eq(pullRequests.id, prId))
          .get(),
      );
      return row?.ts ?? null;
    }),

  setCommentsSyncedAt: (prId, timestamp) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      yield* dbTry("setCommentsSyncedAt", () =>
        db
          .update(pullRequests)
          .set({ commentsSyncedAt: timestamp })
          .where(eq(pullRequests.id, prId))
          .run(),
      );
    }),

  getThreadsFingerprint: (prId) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      const row = yield* dbTry("getThreadsFingerprint", () =>
        db
          .select({ fp: pullRequests.threadsFingerprint })
          .from(pullRequests)
          .where(eq(pullRequests.id, prId))
          .get(),
      );
      return row?.fp ?? null;
    }),

  setThreadsFingerprint: (prId, fingerprint) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      yield* dbTry("setThreadsFingerprint", () =>
        db
          .update(pullRequests)
          .set({ threadsFingerprint: fingerprint })
          .where(eq(pullRequests.id, prId))
          .run(),
      );
    }),

  appendMentionedUsers: (prId, logins) =>
    Effect.gen(function* () {
      if (logins.length === 0) return;
      const { db } = yield* DbService;
      yield* dbTry("appendMentionedUsers", () => mergeMentionedUsers(db, prId, logins));
    }),
});
