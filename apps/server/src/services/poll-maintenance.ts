/**
 * The maintenance phases of `PollScheduler.syncAllRepos` — work that runs
 * after the open-PR list has gone out, because nothing on screen waits on it.
 */
import type { PullRequest, Repository } from "@revv/shared";
import { and, inArray, isNotNull, lt } from "drizzle-orm";
import type { Context } from "effect";
import { Effect } from "effect";
import { daysBefore, type RetentionPolicy } from "../db/retention";
import { pullRequests } from "../db/schema/pull-requests";
import { withDb } from "../effects/with-db";
import { logError } from "../logger";
import type { DbService } from "./Db";
import type { DiffCacheService } from "./DiffCache";
import type { GitHubAccounts } from "./github/accounts";
import type { AvatarCache } from "./github/avatars";
import type { GitHubGateway } from "./github/gateway";
import type { PrMirror } from "./PrMirror";
import type { PullRequestService } from "./PullRequest";
import type { AccountGate } from "./poll-gate";
import type { Realtime } from "./Realtime";
import type { RepositoryService } from "./Repository";

/** The local archive holds the last week of closed and merged PRs. */
const ARCHIVE_DAYS = 7;

/** Deleting a PR cascades to its walkthroughs, sessions, chats, diff files and pins. */
export const prArchiveRetention: RetentionPolicy = {
  table: "pull_requests",
  sweep: (db, now) =>
    db
      .delete(pullRequests)
      .where(
        and(
          inArray(pullRequests.status, ["closed", "merged"]),
          isNotNull(pullRequests.closedAt),
          lt(pullRequests.closedAt, daysBefore(now, ARCHIVE_DAYS)),
        ),
      )
      .returning({ id: pullRequests.id })
      .all().length,
};
/**
 * Covers the whole archive window in one cycle for an active repo (~13 closed
 * PRs/day × 7 days ≈ 90, with headroom), so a fresh mirror shows the full week.
 * Only unmirrored PRs are fetched, so the burst is one-time.
 */
const ARCHIVE_BACKFILL_MAX_FETCHES_PER_REPO = 150;

/**
 * Bypasses the ETag cache: GitHub Enterprise's signed `avatar_url`s expire
 * without invalidating the endpoint's ETag, so a 304 would replay a dead URL.
 */
export const refreshRepoMetadata = (
  svc: {
    readonly db: Context.Service.Shape<typeof DbService>["db"];
    readonly github: Context.Service.Shape<typeof GitHubGateway>;
    readonly repoService: Context.Service.Shape<typeof RepositoryService>;
    readonly avatars: Context.Service.Shape<typeof AvatarCache>;
    readonly realtime: Context.Service.Shape<typeof Realtime>;
  },
  gate: AccountGate,
  repos: readonly Repository[],
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const { db, github, repoService, avatars, realtime } = svc;
    let anyRepoChanged = false;
    yield* Effect.forEach(
      repos,
      (repo) =>
        Effect.gen(function* () {
          const client = yield* gate.clientForRepo(repo.id, "core");
          if (!client) return;
          const fresh = yield* gate.guarded(github.repos.getFresh(client, repo.fullName));
          if (!fresh) return;
          const avatar = yield* avatars.ensure(repo.githubHost, repo.owner, fresh.ownerAvatarUrl);
          // A repo removed mid-cycle has nothing left to update.
          const updated = yield* withDb(
            db,
            repoService.updateRepoMetadata(repo.id, {
              avatarUrl: fresh.ownerAvatarUrl,
              defaultBranch: fresh.defaultBranch,
            }),
          ).pipe(
            Effect.catchTag("NotFoundError", () => Effect.succeed(null)),
            Effect.catchTag("DbError", (err) =>
              Effect.sync(() => {
                logError("PollScheduler", `recording ${repo.fullName}'s metadata failed:`, err);
                return null;
              }),
            ),
          );
          if (avatar.changed || (updated && updated.defaultBranch !== repo.defaultBranch)) {
            anyRepoChanged = true;
          }
        }),
      { concurrency: 3, discard: true },
    );

    if (anyRepoChanged) {
      for (const accountId of gate.accountIds) {
        yield* withDb(db, repoService.listRepos(accountId)).pipe(
          Effect.flatMap((accountRepos) =>
            realtime.toAccount(accountId, { type: "repos:updated", data: accountRepos }),
          ),
          Effect.catchTag("DbError", (err) =>
            Effect.sync(() => logError("PollScheduler", "announcing repo metadata failed:", err)),
          ),
        );
      }
    }
    return anyRepoChanged;
  });

/**
 * Record each account's current login and avatar. `/user` is read without
 * the ETag cache for the same reason as {@link refreshRepoMetadata}.
 */
export const refreshAccountIdentities = (
  svc: {
    readonly github: Context.Service.Shape<typeof GitHubGateway>;
    readonly accounts: Context.Service.Shape<typeof GitHubAccounts>;
  },
  gate: AccountGate,
): Effect.Effect<void> =>
  Effect.forEach(
    gate.accountIds,
    (accountId) =>
      Effect.gen(function* () {
        const client = yield* gate.clientForAccount(accountId, "core");
        if (!client) return;
        const viewer = yield* gate.guarded(svc.github.users.viewer(client));
        if (!viewer) return;
        yield* svc.accounts
          .recordIdentity(accountId, { login: viewer.login, avatarUrl: viewer.avatarUrl })
          .pipe(
            Effect.catch((e) =>
              Effect.sync(() => logError("PollScheduler", `identity of ${accountId}:`, e)),
            ),
          );
      }),
    { concurrency: 3, discard: true },
  );

/**
 * Re-fill the cached diffs of PRs whose range moved. Sequential, to avoid
 * rate-limit bursts.
 */
export const refetchDiffs = (
  diffCache: Context.Service.Shape<typeof DiffCacheService>,
  gate: AccountGate,
  prs: readonly PullRequest[],
  repoById: ReadonlyMap<string, Repository>,
): Effect.Effect<void> =>
  Effect.forEach(
    prs,
    (pr) =>
      Effect.gen(function* () {
        const repo = repoById.get(pr.repositoryId);
        if (!repo) return;
        const client = yield* gate.clientForRepo(repo.id, "core");
        if (!client) return;
        const filled = yield* gate.guarded(
          diffCache.getOrFetch(pr, repo.fullName, client).pipe(
            Effect.catchTag("DbError", (e) =>
              Effect.sync(() => {
                logError("PollScheduler", `diff refill of ${pr.id}:`, e.message);
                return null;
              }),
            ),
          ),
          `diff refill failed for ${pr.id}`,
        );
        if (filled) yield* Effect.annotateCurrentSpan("files", filled.files.length);
      }).pipe(Effect.withSpan("PollScheduler.refreshPrFiles", { attributes: { prId: pr.id } })),
    { concurrency: 1, discard: true },
  );

/**
 * Catch closed/merged PRs that never made it into the local mirror — closed
 * before the repo was added, or while the server was offline. Bounded to the
 * archive window (`ARCHIVE_DAYS`), with a per-repo fetch cap for bursty
 * repos. Returns whether any PR was added to the archive.
 */
export const backfillArchive = (
  svc: {
    readonly db: Context.Service.Shape<typeof DbService>["db"];
    readonly github: Context.Service.Shape<typeof GitHubGateway>;
    readonly prService: Context.Service.Shape<typeof PullRequestService>;
    readonly mirror: Context.Service.Shape<typeof PrMirror>;
  },
  gate: AccountGate,
  repos: readonly Repository[],
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const { db, github, prService, mirror } = svc;
    const sinceIso = new Date(Date.now() - ARCHIVE_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const untilIso = new Date().toISOString();

    const known = yield* withDb(db, prService.externalIdsByRepo(repos.map((r) => r.id))).pipe(
      Effect.catch((err) =>
        Effect.sync(() => {
          logError("PollScheduler", "archive backfill: reading mirrored PRs failed:", err);
          return null;
        }),
      ),
    );
    if (known === null) return false;

    let added = 0;
    yield* Effect.forEach(
      repos,
      (repo) =>
        Effect.gen(function* () {
          const searchClient = yield* gate.clientForRepo(repo.id, "search");
          if (!searchClient) return;
          const searched = yield* gate.guarded(
            github.prs.searchClosedInWindow(searchClient, repo.fullName, sinceIso, untilIso),
            `archive backfill search failed for ${repo.fullName}`,
          );
          if (!searched || searched.length === 0) return;

          const mirrored = known.get(repo.id) ?? new Set<number>();
          const missing = searched
            .filter((s) => !mirrored.has(s.number))
            .slice(0, ARCHIVE_BACKFILL_MAX_FETCHES_PER_REPO);
          if (missing.length === 0) return;
          const detailClient = yield* gate.clientForRepo(repo.id, "graphql");
          if (!detailClient) return;

          const fetched = yield* gate.guarded(
            github.prs.getMany(
              detailClient,
              repo.fullName,
              repo.id,
              missing.map((m) => m.number),
            ),
            `archive backfill read failed for ${repo.fullName}`,
          );
          if (!fetched || fetched.size === 0) return;
          yield* mirror.apply([...fetched.values()], { announce: false }).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                added += fetched.size;
              }),
            ),
            Effect.catch((err) =>
              Effect.sync(() =>
                logError(
                  "PollScheduler",
                  `archive backfill write failed for ${repo.fullName}:`,
                  err,
                ),
              ),
            ),
          );
        }),
      { concurrency: 3, discard: true },
    );
    return added > 0;
  });
