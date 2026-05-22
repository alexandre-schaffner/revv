import type { PullRequest, SyncChange } from "@revv/shared";
import { AUTO_FETCH_DEFAULT_INTERVAL, THREAD_SYNC_INTERVAL_SECONDS } from "@revv/shared";
import { eq, inArray } from "drizzle-orm";
import { Cause, Chunk, Context, Duration, Effect, Fiber, Layer, Ref, Schedule } from "effect";
import { repositories } from "../db/schema";
import { account, user } from "../db/schema/auth";
import { withDb as withDbHelper } from "../effects/with-db";
import { logError } from "../logger";
import { DbService } from "./Db";
import { DiffCacheService } from "./DiffCache";
import { GitHubService } from "./GitHub";
import { GitHubEtagCache } from "./GitHubEtagCache";
import { PullRequestService } from "./PullRequest";
import { RemoteUserService } from "./RemoteUser";
import { RepositoryService } from "./Repository";
import { SettingsService } from "./Settings";
import { SyncService } from "./Sync";
import { WalkthroughService } from "./Walkthrough";
import { WalkthroughJobs } from "./WalkthroughJobs";
import { WebSocketHub } from "./WebSocketHub";

type PollSchedulerService = {
  readonly start: () => Effect.Effect<void>;
  readonly stop: () => Effect.Effect<void>;
  readonly restart: (intervalMinutes: number) => Effect.Effect<void>;
  readonly syncNow: () => Effect.Effect<void>;
  readonly syncThreadsNow: (prId: string) => Effect.Effect<void>;
};

export class PollScheduler extends Context.Tag("PollScheduler")<
  PollScheduler,
  PollSchedulerService
>() {}

/** Derive the GitHub REST API base URL from a stored repo host string. */
function hostToApiBase(host: string): string {
  return host === "github.com" ? "https://api.github.com" : `https://api.${host}`;
}

export const PollSchedulerLive = Layer.effect(
  PollScheduler,
  Effect.gen(function* () {
    // Capture all dependencies once at layer construction time
    const hub = yield* WebSocketHub;
    const github = yield* GitHubService;
    const prService = yield* PullRequestService;
    const remoteUserService = yield* RemoteUserService;
    const diffCache = yield* DiffCacheService;
    const repoService = yield* RepositoryService;
    const settingsService = yield* SettingsService;
    const syncService = yield* SyncService;
    const etagCache = yield* GitHubEtagCache;
    const walkthroughJobs = yield* WalkthroughJobs;
    const walkthroughService = yield* WalkthroughService;
    const { db } = yield* DbService;

    // Bind the captured db handle for convenience
    const withDb = <A, E>(eff: Effect.Effect<A, E, DbService>) => withDbHelper(db, eff);

    // Provide `DbService` + `GitHubEtagCache` (both captured at layer
    // construction) so effects that transitively call `github.*` REST methods
    // — which now participate in the ETag cache — don't leak those services
    // into the public Tag signatures.
    const provideInfra = <A, E>(
      eff: Effect.Effect<A, E, DbService | GitHubEtagCache | SettingsService>,
    ): Effect.Effect<A, E> =>
      eff.pipe(
        Effect.provideService(DbService, { db }),
        Effect.provideService(GitHubEtagCache, etagCache),
        Effect.provideService(SettingsService, settingsService),
      );

    // Tracks whether at least one periodic sync has completed.
    // The first periodic sync is used as baseline — we don't know what
    // changed vs the prior server run, so we skip notifications for it.
    const hasPeriodicSyncedOnceRef = yield* Ref.make(false);
    // Set to true by syncNow to suppress the summary during manual syncs.
    const suppressSummaryRef = yield* Ref.make(false);

    // Fiber ref for the running poll loop — null when stopped
    const fiberRef = yield* Ref.make<Fiber.RuntimeFiber<number, never> | null>(null);

    // The core sync effect — all services are plain values captured from the closure.
    // `DbService | GitHubEtagCache | SettingsService` remain in R because `github.*`
    // methods depend on them internally; the layer that constructs PollScheduler
    // already has all provided, so the forked fiber inherits them.
    const syncAllRepos: Effect.Effect<void, never, DbService | GitHubEtagCache | SettingsService> =
      Effect.gen(function* () {
        yield* hub.broadcast({ type: "prs:sync-started" });

        // Snapshot ETag-cache counters so we can report deltas for this cycle.
        const etagStatsBefore = etagCache.stats();

        const allRepos = yield* withDb(repoService.listRepos());

        if (allRepos.length === 0) {
          const etagStatsAfter = etagCache.stats();
          yield* hub.broadcast({
            type: "prs:sync-complete",
            data: {
              count: 0,
              timestamp: new Date().toISOString(),
              cached: etagStatsAfter.hits304 - etagStatsBefore.hits304,
              refetched: etagStatsAfter.misses200 - etagStatsBefore.misses200,
            },
          });
          return;
        }

        // ── Hydrate per-repo account context ─────────────────────────────────
        // Each repo is bound to a specific `account.id` (its owning OAuth
        // connection). We resolve the per-repo account + token here, ONCE,
        // and use it everywhere below — instead of falling back to
        // `getGitHubToken("single-user", host)`, which silently picks "first
        // user in the user table, first account row matching the host" and
        // therefore mixes up identities the moment two users or two accounts
        // on the same host coexist on this machine.
        type AccountCtx = {
          readonly id: string;
          readonly userId: string;
          readonly accessToken: string | null;
          readonly githubLogin: string | null;
          readonly avatarUrl: string | null;
        };
        const repoRowsForAccount = db
          .select({ id: repositories.id, accountId: repositories.accountId })
          .from(repositories)
          .all();
        const repoToAccountId = new Map(repoRowsForAccount.map((r) => [r.id, r.accountId]));
        const accountIdSet = Array.from(new Set(repoRowsForAccount.map((r) => r.accountId)));
        const accountRows: AccountCtx[] =
          accountIdSet.length > 0
            ? db
                .select({
                  id: account.id,
                  userId: account.userId,
                  accessToken: account.accessToken,
                  githubLogin: account.githubLogin,
                  avatarUrl: account.avatarUrl,
                })
                .from(account)
                .where(inArray(account.id, accountIdSet))
                .all()
            : [];
        const accountById = new Map(accountRows.map((a) => [a.id, a]));
        const accountForRepo = (repoId: string): AccountCtx | null => {
          const accId = repoToAccountId.get(repoId);
          if (!accId) return null;
          return accountById.get(accId) ?? null;
        };

        // Capture existing SHAs before sync for change detection
        const existingPrs = yield* withDb(prService.listPrs());
        const existingShaMap = new Map(
          existingPrs.map((pr) => [pr.id, { headSha: pr.headSha, baseSha: pr.baseSha }]),
        );

        // ── Refresh repo metadata (avatar URL, default branch) ────────────────
        // Bypasses the ETag cache — some GitHub Enterprise instances return
        // signed `avatar_url`s whose token expires without invalidating the
        // endpoint's ETag, so a plain `getRepo` would replay the stale body.
        // Runs before PR sync so the sidebar sees fresh avatars ASAP after
        // server startup.
        let anyRepoChanged = false;
        yield* Effect.forEach(
          allRepos,
          (repo) =>
            Effect.gen(function* () {
              const acc = accountForRepo(repo.id);
              const token = acc?.accessToken ?? "";
              if (!token) return;
              const repoApiBase = hostToApiBase(repo.githubHost);
              const fresh = yield* github
                .getRepoFresh(repo.fullName, token, repoApiBase)
                .pipe(Effect.catchAll(() => Effect.succeed(null)));
              if (!fresh) return;
              if (
                fresh.avatarUrl !== repo.avatarUrl ||
                fresh.defaultBranch !== repo.defaultBranch
              ) {
                yield* withDb(
                  repoService.updateRepoMetadata(repo.id, {
                    avatarUrl: fresh.avatarUrl,
                    defaultBranch: fresh.defaultBranch,
                  }),
                ).pipe(Effect.orElseSucceed(() => undefined));
                anyRepoChanged = true;
              }
            }).pipe(Effect.orElseSucceed(() => undefined)),
          { concurrency: 3 },
        );

        if (anyRepoChanged) {
          const refreshedRepos = yield* withDb(repoService.listRepos());
          // Group by account and broadcast per-account so each connected client
          // only receives repos for the account it is authenticated against.
          const reposByAccount = Map.groupBy(
            refreshedRepos,
            (r) => repoToAccountId.get(r.id) ?? "unknown",
          );
          for (const [accountId, accountRepos] of reposByAccount) {
            yield* hub.broadcastToAccount(accountId, { type: "repos:updated", data: accountRepos });
          }
        }

        // ── Refresh per-account user avatar + githubLogin ────────────────────
        // Same rationale as the repo-metadata refresh above: GitHub Enterprise
        // signed `avatar_url`s on the /user endpoint expire without the ETag
        // changing, so a cached response replays a dead token. Bypassing the
        // ETag cache keeps the stored avatar URLs fresh so sidebars, comment
        // headers, and the settings page don't render broken avatars after the
        // signed URL rotates.
        //
        // We refresh PER ACCOUNT (not "the first user") because each account
        // has its own OAuth identity — github_login + avatar_url live on the
        // `account` row, and the connected client's WS is account-scoped. The
        // `user.image` mirror is updated to the avatar of one of the user's
        // accounts so existing code that reads `user.image` keeps working.
        yield* Effect.forEach(
          accountRows,
          (acc) =>
            Effect.gen(function* () {
              if (!acc.accessToken) return;
              const fresh = yield* github
                .getAuthenticatedUserFresh(acc.accessToken)
                .pipe(Effect.catchAll(() => Effect.succeed(null)));
              if (!fresh) return;

              const avatarChanged = acc.avatarUrl !== fresh.avatarUrl;
              const loginChanged = acc.githubLogin !== fresh.login;
              if (!avatarChanged && !loginChanged) return;

              const now = new Date();
              yield* Effect.try({
                try: () =>
                  db
                    .update(account)
                    .set({
                      avatarUrl: fresh.avatarUrl,
                      githubLogin: fresh.login,
                      updatedAt: now,
                    })
                    .where(eq(account.id, acc.id))
                    .run(),
                catch: (e) => new Error(String(e)),
              }).pipe(Effect.orElseSucceed(() => undefined));

              // Keep the in-memory map coherent for downstream consumers in
              // this same sync cycle (e.g. the change-detection loop below).
              accountById.set(acc.id, {
                ...acc,
                avatarUrl: fresh.avatarUrl,
                githubLogin: fresh.login,
              });

              // Mirror to the user row so existing code that reads
              // `user.image` / `user.github_login` keeps working. Only touch
              // the row if our values actually differ.
              const userRow = db
                .select({ id: user.id, name: user.name, email: user.email, image: user.image })
                .from(user)
                .where(eq(user.id, acc.userId))
                .get();
              if (!userRow) return;
              const needsUserUpdate = userRow.image !== fresh.avatarUrl || loginChanged === true;
              if (needsUserUpdate) {
                yield* Effect.try({
                  try: () =>
                    db
                      .update(user)
                      .set({
                        image: fresh.avatarUrl,
                        githubLogin: fresh.login,
                        updatedAt: now,
                      })
                      .where(eq(user.id, acc.userId))
                      .run(),
                  catch: (e) => new Error(String(e)),
                }).pipe(Effect.orElseSucceed(() => undefined));
              }

              // Broadcast scoped to this account's WS clients so only the
              // sessions actually authenticated against `acc` see the avatar
              // swap. The full broadcast path would leak A's avatar to B.
              yield* hub.broadcastToAccount(acc.id, {
                type: "user:updated",
                data: {
                  id: userRow.id,
                  name: userRow.name,
                  email: userRow.email,
                  image: fresh.avatarUrl,
                  githubLogin: fresh.login,
                },
              });
            }).pipe(Effect.orElseSucceed(() => undefined)),
          { concurrency: 3 },
        );

        const results = yield* Effect.forEach(
          allRepos,
          (repo) =>
            Effect.gen(function* () {
              // Auth failures must not silently poison the token: log + skip this
              // repo's PR sync this cycle.
              const acc = accountForRepo(repo.id);
              const token = acc?.accessToken ?? "";
              if (!token) {
                logError(
                  "PollScheduler",
                  `GitHub auth unavailable; skipping PR sync for ${repo.fullName} (account ${
                    acc?.id ?? repoToAccountId.get(repo.id) ?? "missing"
                  })`,
                );
                return null;
              }

              const repoApiBase = hostToApiBase(repo.githubHost);
              const prs = yield* github.listPrs(repo.fullName, repo.id, token, repoApiBase).pipe(
                Effect.tapError((err) =>
                  Effect.sync(() => {
                    logError("PollScheduler", `listPrs error for ${repo.fullName}:`, err);
                  }),
                ),
                Effect.map((fetched) => fetched as PullRequest[] | null),
                Effect.catchAll(() => Effect.succeed(null as PullRequest[] | null)),
              );

              // listPrs failed — leave existing DB rows untouched for this repo
              if (prs === null) return null;

              // Upsert PR authors into remote_users so their avatars are cached.
              for (const pr of prs) {
                yield* remoteUserService.upsert({
                  provider: "github",
                  providerUserId: "", // Numeric ID not available from listPrs
                  login: pr.authorLogin,
                  avatarUrl: pr.authorAvatarUrl,
                });
              }

              yield* withDb(prService.upsertPrs(prs)).pipe(
                Effect.tapError((err) =>
                  Effect.sync(() => {
                    logError("PollScheduler", `upsertPrs error for ${repo.fullName}:`, err);
                  }),
                ),
                Effect.orElseSucceed(() => undefined),
              );

              return prs;
            }).pipe(
              Effect.tapError((err) =>
                Effect.sync(() => {
                  logError("PollScheduler", `outer per-repo sync error for ${repo.fullName}:`, err);
                }),
              ),
              Effect.orElseSucceed(() => null as PullRequest[] | null),
            ),
          { concurrency: 3 },
        );

        const allPrs = results.flatMap((r) => r ?? []);

        // Delete PRs that were open before but are gone now (closed/merged on GitHub).
        // Only consider repos whose sync succeeded (result !== null) — if listPrs failed
        // for a repo, its existing DB rows are left untouched this cycle.
        // Cascade deletes their diff cache, review sessions, threads, and walkthroughs.
        const syncedRepoIds = new Set(
          allRepos.filter((_, i) => results[i] !== null).map((r) => r.id),
        );
        const freshPrIdSet = new Set(allPrs.map((pr) => pr.id));
        const closedPrIds = existingPrs
          .filter(
            (pr) =>
              pr.status === "open" &&
              syncedRepoIds.has(pr.repositoryId) &&
              !freshPrIdSet.has(pr.id),
          )
          .map((pr) => pr.id);
        if (closedPrIds.length > 0) {
          const repoMap = new Map(allRepos.map((r) => [r.id, r]));
          const closedPrObjects = existingPrs.filter((pr) => closedPrIds.includes(pr.id));

          const updates: Array<{ id: string; status: "closed" | "merged"; closedAt: string }> =
            yield* Effect.forEach(
              closedPrObjects,
              (pr) =>
                Effect.gen(function* () {
                  // Cap at 10 API fetches per cycle to avoid hammering GitHub
                  if (closedPrIds.length > 10) {
                    return {
                      id: pr.id,
                      status: "closed" as const,
                      closedAt: new Date().toISOString(),
                    };
                  }
                  const repo = repoMap.get(pr.repositoryId);
                  if (!repo) {
                    return {
                      id: pr.id,
                      status: "closed" as const,
                      closedAt: new Date().toISOString(),
                    };
                  }
                  const token = accountForRepo(repo.id)?.accessToken ?? "";
                  if (!token) {
                    return {
                      id: pr.id,
                      status: "closed" as const,
                      closedAt: new Date().toISOString(),
                    };
                  }
                  const fetched = yield* github
                    .getPr(repo.fullName, pr.externalId, token)
                    .pipe(Effect.catchAll(() => Effect.succeed(null)));
                  if (!fetched) {
                    return {
                      id: pr.id,
                      status: "closed" as const,
                      closedAt: new Date().toISOString(),
                    };
                  }
                  const resolvedStatus = fetched.status === "merged" ? "merged" : "closed";
                  const closedAt = fetched.closedAt ?? new Date().toISOString();
                  return { id: pr.id, status: resolvedStatus as "closed" | "merged", closedAt };
                }),
              { concurrency: 5 },
            );

          yield* withDb(prService.markPrsClosed(updates)).pipe(
            Effect.orElseSucceed(() => undefined),
          );

          // Targeted `pr:archived` envelopes for each transition. The full
          // PR set still goes out via the `prs:updated` broadcast below;
          // this gives clients a low-latency signal they can patch in
          // place without refetching the archive list. Best-effort — if a
          // single emit fails, the bulk update still reconciles on the
          // next `prs:updated` arrival.
          const closedPrMap = new Map(closedPrObjects.map((pr) => [pr.id, pr]));
          for (const upd of updates) {
            const pr = closedPrMap.get(upd.id);
            if (!pr) continue;
            const accountId = repoToAccountId.get(pr.repositoryId);
            if (!accountId) continue;
            yield* hub
              .broadcastToAccount(accountId, {
                type: "pr:archived",
                data: {
                  prId: upd.id,
                  repoId: pr.repositoryId,
                  status: upd.status,
                  closedAt: upd.closedAt,
                },
              })
              .pipe(Effect.orElseSucceed(() => undefined));
          }
        }

        // ── Archive backfill ─────────────────────────────────────────────────
        // Catch closed/merged PRs that never made it into the local mirror —
        // e.g. closed before the user added the repo to Revv, or while the
        // server was offline for longer than one poll interval. Bounded to
        // the same 7-day window the DbMaintenance sweep uses for retention,
        // so the local archive converges on "last week of activity" from
        // GitHub. Per-repo fetch cap defends against bursty repos. Failures
        // are non-fatal — we degrade silently to whatever the local mirror
        // already has.
        const ARCHIVE_BACKFILL_DAYS = 7;
        const ARCHIVE_BACKFILL_MAX_FETCHES_PER_REPO = 25;
        const backfillSinceIso = new Date(
          Date.now() - ARCHIVE_BACKFILL_DAYS * 24 * 60 * 60 * 1000,
        ).toISOString();
        const backfillUntilIso = new Date().toISOString();

        const existingExternalIdsByRepo = new Map<string, Set<number>>();
        for (const pr of existingPrs) {
          let set = existingExternalIdsByRepo.get(pr.repositoryId);
          if (!set) {
            set = new Set<number>();
            existingExternalIdsByRepo.set(pr.repositoryId, set);
          }
          set.add(pr.externalId);
        }

        yield* Effect.forEach(
          allRepos,
          (repo) =>
            Effect.gen(function* () {
              const acc = accountForRepo(repo.id);
              const token = acc?.accessToken ?? "";
              if (!token) return;

              const searched = yield* github
                .searchClosedPrsInWindow(repo.fullName, backfillSinceIso, backfillUntilIso, token)
                .pipe(
                  Effect.tapError((err) =>
                    Effect.sync(() => {
                      logError(
                        "PollScheduler",
                        `archive backfill search failed for ${repo.fullName}:`,
                        err,
                      );
                    }),
                  ),
                  Effect.catchAll(() =>
                    Effect.succeed(
                      [] as ReadonlyArray<{
                        readonly number: number;
                        readonly closedAt: string;
                        readonly merged: boolean;
                      }>,
                    ),
                  ),
                );
              if (searched.length === 0) return;

              const known = existingExternalIdsByRepo.get(repo.id) ?? new Set<number>();
              const missing = searched
                .filter((s) => !known.has(s.number))
                .slice(0, ARCHIVE_BACKFILL_MAX_FETCHES_PER_REPO);
              if (missing.length === 0) return;

              const fetched = yield* Effect.forEach(
                missing,
                (m) =>
                  github
                    .getPr(repo.fullName, m.number, token)
                    .pipe(Effect.catchAll(() => Effect.succeed(null))),
                { concurrency: 3 },
              );

              // Repoint every fetched row at our local repo id — `getPr`
              // derives `id` and `repositoryId` from `${owner}/${repo}` because
              // it doesn't know the local row id. Matches the recap-jobs
              // backfill (see ProjectRecapJobs.backfillMissingPrs).
              const upsertable = fetched
                .filter((pr): pr is NonNullable<typeof pr> => pr !== null)
                .map((pr) => ({
                  ...pr,
                  id: `${repo.id}:${pr.externalId}`,
                  repositoryId: repo.id,
                }));
              if (upsertable.length === 0) return;

              yield* withDb(prService.upsertPrs(upsertable)).pipe(
                Effect.tapError((err) =>
                  Effect.sync(() => {
                    logError(
                      "PollScheduler",
                      `archive backfill upsert failed for ${repo.fullName}:`,
                      err,
                    );
                  }),
                ),
                Effect.orElseSucceed(() => undefined),
              );
            }).pipe(Effect.orElseSucceed(() => undefined)),
          { concurrency: 3 },
        );

        // Detect PRs whose headSha or baseSha changed since last sync
        const changedPrIds = allPrs
          .filter((pr) => {
            const existing = existingShaMap.get(pr.id);
            if (!existing) return false; // new PR — no cached diffs yet
            return existing.headSha !== pr.headSha || existing.baseSha !== pr.baseSha;
          })
          .map((pr) => pr.id);

        // Head-SHA change → walkthroughs for this PR pin to the OLD SHA and
        // are now stale. Per doctrine invariant #7 (walkthroughs are immutable
        // per head SHA), we mark them 'superseded' rather than mutate or
        // delete. A fresh walkthrough row is created on the next user-opens-PR
        // flow for the new SHA.
        //
        // We pass the NEW headSha as `exceptHeadSha` so a walkthrough the
        // SSE handler may have just created at that SHA (the user clicked
        // Generate while this poll was mid-flight) survives — it's by
        // definition not stale, since "stale" means "pinned to an old
        // SHA we just learned has been replaced."
        const headShaChanged = allPrs.flatMap((pr) => {
          const existing = existingShaMap.get(pr.id);
          if (existing === undefined || existing.headSha === pr.headSha) {
            return [];
          }
          return [{ prId: pr.id, newHeadSha: pr.headSha ?? undefined }];
        });
        for (const { prId, newHeadSha } of headShaChanged) {
          yield* walkthroughJobs
            .supersedeForPr(prId, newHeadSha)
            .pipe(Effect.catchAll(() => Effect.void));
        }

        // Refresh diffs only for PRs that had SHA changes AND already have cached diffs
        if (changedPrIds.length > 0) {
          const cachedPrIds = yield* withDb(diffCache.getPrIdsWithCachedDiffs());
          const cachedSet = new Set(cachedPrIds);
          const toRefresh = changedPrIds.filter((id) => cachedSet.has(id));

          if (toRefresh.length > 0) {
            // Invalidate stale cache entries first
            yield* withDb(diffCache.invalidateFilesForPrs(toRefresh)).pipe(
              Effect.orElseSucceed(() => undefined),
            );

            // Re-fetch diffs sequentially to avoid rate limit bursts
            yield* Effect.forEach(
              toRefresh,
              (prId) =>
                Effect.gen(function* () {
                  const pr = allPrs.find((p) => p.id === prId);
                  if (!pr) return;

                  const repo = allRepos.find((r) => r.id === pr.repositoryId);
                  if (!repo) return;

                  const token = accountForRepo(repo.id)?.accessToken ?? "";
                  if (!token) {
                    logError(
                      "PollScheduler",
                      `GitHub auth unavailable; skipping diff refresh for PR ${prId} (repo ${repo.fullName})`,
                    );
                    return;
                  }

                  const fileList = yield* github
                    .getPrFiles(repo.fullName, pr.externalId, token)
                    .pipe(Effect.orElseSucceed(() => []));

                  const files = fileList.map((f) => ({
                    path: f.filename,
                    oldPath: f.previousFilename,
                    status: f.status,
                    additions: f.additions,
                    deletions: f.deletions,
                    patch: f.patch,
                    fetchedAt: new Date().toISOString(),
                  }));

                  yield* withDb(diffCache.cacheFiles(prId, files)).pipe(
                    Effect.orElseSucceed(() => undefined),
                  );
                }).pipe(Effect.orElseSucceed(() => undefined)),
              { concurrency: 1 },
            );
          }
        }

        // Broadcast the canonical open-PR DB state per account. This includes
        // repos whose GitHub fetch failed this cycle, so clients can safely
        // treat `prs:updated` as full-state instead of a merge patch.
        for (const accountId of accountIdSet) {
          const accountPrs = yield* withDb(prService.listPrs(accountId));
          yield* hub.broadcastToAccount(accountId, { type: "prs:updated", data: accountPrs });
        }

        // ── Sync diff: compute what changed for notifications ────────────────
        const changes: SyncChange[] = [];
        const existingMap = new Map(existingPrs.map((pr) => [pr.id, pr]));

        if (existingPrs.length > 0) {
          for (const pr of allPrs) {
            const repoFullName =
              allRepos.find((r) => r.id === pr.repositoryId)?.fullName ?? pr.repositoryId;
            // The "is this PR for me" check is per-account: each repo is owned
            // by exactly one OAuth account, and `account.github_login` is that
            // account's GitHub identity. Using the first user's githubLogin
            // (the previous behavior) misattributes review requests as soon as
            // multiple users or multiple accounts on the same host exist.
            const userLogin = accountForRepo(pr.repositoryId)?.githubLogin ?? null;
            const existing = existingMap.get(pr.id);

            if (!existing) {
              if (userLogin && pr.requestedReviewers.includes(userLogin)) {
                changes.push({
                  kind: "review_requested",
                  prId: pr.id,
                  prTitle: pr.title,
                  prNumber: pr.externalId,
                  repoFullName,
                });
              } else if (userLogin && pr.authorLogin === userLogin) {
                changes.push({
                  kind: "pr_authored",
                  prId: pr.id,
                  prTitle: pr.title,
                  prNumber: pr.externalId,
                  repoFullName,
                });
              }
            } else {
              if (existing.headSha !== pr.headSha) {
                changes.push({
                  kind: "pr_updated",
                  prId: pr.id,
                  prTitle: pr.title,
                  prNumber: pr.externalId,
                  repoFullName,
                });
              } else if (
                userLogin &&
                pr.requestedReviewers.includes(userLogin) &&
                !existing.requestedReviewers.includes(userLogin)
              ) {
                changes.push({
                  kind: "review_requested",
                  prId: pr.id,
                  prTitle: pr.title,
                  prNumber: pr.externalId,
                  repoFullName,
                });
              }
            }
          }

          for (const prId of closedPrIds) {
            const pr = existingMap.get(prId);
            if (pr) {
              const repoFullName =
                allRepos.find((r) => r.id === pr.repositoryId)?.fullName ?? pr.repositoryId;
              changes.push({
                kind: "pr_closed",
                prId: prId,
                prTitle: pr.title,
                prNumber: pr.externalId,
                repoFullName,
              });
            }
          }
        }

        const suppressSummary = yield* Ref.get(suppressSummaryRef);
        const hasPeriodicSyncedOnce = yield* Ref.get(hasPeriodicSyncedOnceRef);
        if (!suppressSummary && hasPeriodicSyncedOnce && changes.length > 0) {
          // Group changes by account and broadcast per-account. Closed PRs are
          // no longer present in `allPrs`, so resolve their account from the
          // pre-sync row instead of dropping them into an `unknown` bucket.
          const changeAccountByPrId = new Map<string, string>();
          for (const pr of allPrs) {
            const accountId = repoToAccountId.get(pr.repositoryId);
            if (accountId) changeAccountByPrId.set(pr.id, accountId);
          }
          for (const prId of closedPrIds) {
            const pr = existingMap.get(prId);
            if (!pr) continue;
            const accountId = repoToAccountId.get(pr.repositoryId);
            if (accountId) changeAccountByPrId.set(prId, accountId);
          }

          const changesByAccount = Map.groupBy(
            changes,
            (c) => changeAccountByPrId.get(c.prId) ?? "unknown",
          );
          for (const [accountId, accountChanges] of changesByAccount) {
            yield* hub.broadcastToAccount(accountId, {
              type: "prs:sync-summary",
              data: accountChanges,
            });
          }

          // Auto-trigger walkthroughs for newly-requested reviews so they're
          // ready (or already streaming) by the time the user opens the PR.
          // Gated by the same `!suppressSummary && hasPeriodicSyncedOnce`
          // condition as the broadcast: the first periodic sync is a baseline
          // (we don't know what was new since the prior server run) and
          // manual `syncNow` calls are diagnostic — neither should
          // mass-spawn AI jobs. Fire-and-forget: the sync loop must not
          // block on AI work, and `startJob` already daemon-forks the
          // actual generation fiber.
          for (const change of changes) {
            if (change.kind !== "review_requested") continue;
            const pr = allPrs.find((p) => p.id === change.prId);
            if (!pr || pr.headSha === null) continue;
            const cached = yield* withDb(walkthroughService.getCached(pr.id, pr.headSha));
            if (cached !== null) continue;
            yield* Effect.forkDaemon(
              walkthroughJobs
                .startJob({
                  prId: pr.id,
                  userId: "single-user",
                  trigger: "review_requested",
                })
                .pipe(
                  Effect.catchAllCause((cause) =>
                    Effect.sync(() => {
                      logError(
                        "PollScheduler",
                        `Auto-walkthrough trigger failed for PR ${pr.id} (${change.repoFullName}#${change.prNumber}):`,
                        Cause.pretty(cause),
                      );
                    }),
                  ),
                ),
            );
          }
        }
        yield* Ref.set(hasPeriodicSyncedOnceRef, true);
        yield* Ref.set(suppressSummaryRef, false);

        const etagStatsAfter = etagCache.stats();
        yield* hub.broadcast({
          type: "prs:sync-complete",
          data: {
            count: allPrs.length,
            timestamp: new Date().toISOString(),
            cached: etagStatsAfter.hits304 - etagStatsBefore.hits304,
            refetched: etagStatsAfter.misses200 - etagStatsBefore.misses200,
          },
        });
      }).pipe(
        Effect.tapErrorCause((cause) =>
          Effect.sync(() => {
            logError("PollScheduler", "syncAllRepos top-level failure:", Cause.pretty(cause));
          }),
        ),
        Effect.catchAllCause((cause) =>
          hub.broadcast({
            type: "error",
            data: { code: "SYNC_ERROR", message: String(cause) },
          }),
        ),
      );

    const stopFiber: Effect.Effect<void> = Effect.gen(function* () {
      const fiber = yield* Ref.get(fiberRef);
      if (fiber !== null) {
        yield* Fiber.interrupt(fiber).pipe(Effect.asVoid);
        yield* Ref.set(fiberRef, null);
      }
    });

    // ── Thread sync loop ──────────────────────────────────────────────────
    // Separate, lightweight fiber that polls every ~30s to keep threads in
    // sync with GitHub. Runs in addition to the PR-sync fiber above.
    const threadFiberRef = yield* Ref.make<Fiber.RuntimeFiber<number, never> | null>(null);

    const syncThreadsForOpenPrs: Effect.Effect<void> = Effect.gen(function* () {
      const prs = yield* withDb(prService.listPrs()).pipe(
        Effect.orElseSucceed(() => [] as PullRequest[]),
      );
      const openPrs = prs.filter((p) => p.status === "open");
      // Sequential is fine: each PR-sync is lightweight (REST + a small
      // GraphQL call). Running them concurrently would spike rate-limit risk.
      yield* Effect.forEach(
        openPrs,
        (pr) =>
          provideInfra(syncService.syncThreads(pr.id)).pipe(
            Effect.asVoid,
            Effect.catchAllCause((cause) =>
              Effect.sync(() => {
                logError(
                  "PollScheduler",
                  `Thread sync failed for PR ${pr.id}:`,
                  Cause.pretty(cause),
                );
              }),
            ),
          ),
        { concurrency: 1 },
      );
    }).pipe(
      Effect.catchAllCause((cause) =>
        hub.broadcast({
          type: "error",
          data: { code: "THREAD_SYNC_ERROR", message: String(cause) },
        }),
      ),
    );

    const stopThreadFiber: Effect.Effect<void> = Effect.gen(function* () {
      const fiber = yield* Ref.get(threadFiberRef);
      if (fiber !== null) {
        yield* Fiber.interrupt(fiber).pipe(Effect.asVoid);
        yield* Ref.set(threadFiberRef, null);
      }
    });

    const startThreadFiber: Effect.Effect<void> = Effect.gen(function* () {
      const schedule = Schedule.spaced(Duration.seconds(THREAD_SYNC_INTERVAL_SECONDS));
      const fiber: Fiber.RuntimeFiber<number, never> = yield* Effect.fork(
        syncThreadsForOpenPrs.pipe(Effect.repeat(schedule)),
      );
      yield* Ref.set(threadFiberRef, fiber);
    });

    const startWithInterval = (intervalMinutes: number): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (intervalMinutes <= 0) return;
        // Run immediately on start, then repeat at the given interval
        const schedule = Schedule.spaced(Duration.minutes(intervalMinutes));
        const fiber: Fiber.RuntimeFiber<number, never> = yield* Effect.fork(
          provideInfra(syncAllRepos.pipe(Effect.repeat(schedule))),
        );
        yield* Ref.set(fiberRef, fiber);
      });

    return {
      start: () =>
        Effect.gen(function* () {
          // Guard: don't start duplicate fibers if already running
          const existingFiber = yield* Ref.get(threadFiberRef);
          if (existingFiber !== null) return;

          const s = yield* withDb(settingsService.getSettings()).pipe(
            Effect.orElseSucceed(() => ({ autoFetchInterval: AUTO_FETCH_DEFAULT_INTERVAL })),
          );
          yield* startWithInterval(s.autoFetchInterval);
          yield* startThreadFiber;
        }),

      stop: () =>
        Effect.gen(function* () {
          yield* stopFiber;
          yield* stopThreadFiber;
        }),

      restart: (minutes) =>
        Effect.gen(function* () {
          yield* stopFiber;
          yield* startWithInterval(minutes);
        }),

      syncNow: () =>
        provideInfra(
          Effect.gen(function* () {
            yield* Ref.set(suppressSummaryRef, true);
            yield* syncAllRepos;
          }),
        ),

      syncThreadsNow: (prId: string) =>
        provideInfra(syncService.syncThreads(prId)).pipe(
          Effect.asVoid,
          Effect.catchIf(
            (e) => (e as { _tag?: string })._tag === "NotFoundError",
            () => Effect.void,
          ),
          Effect.catchAllCause((cause) => {
            // Cause.pretty alone collapses to "An error has occurred"
            // when the failure's wrapper Error has no useful .message.
            // Dig into the typed failure (SyncError carries `.cause`
            // pointing at whatever blew up underneath) and print BOTH
            // the pretty cause AND the underlying error's message +
            // stack so we can actually diagnose what broke.
            const pretty = Cause.pretty(cause);
            const failure = Cause.failureOption(cause);
            const detail = (() => {
              if (failure._tag !== "Some") return null;
              const v = failure.value as {
                _tag?: string;
                message?: string;
                cause?: unknown;
                threadId?: string;
              };
              const tag = v._tag ?? "unknown";
              const msg = v.message ?? null;
              const inner =
                v.cause instanceof Error
                  ? `${v.cause.name}: ${v.cause.message}\n${v.cause.stack ?? ""}`
                  : v.cause != null
                    ? String(v.cause)
                    : null;
              const tid = v.threadId ? ` (thread ${v.threadId})` : "";
              return [tag + tid, msg, inner].filter(Boolean).join(" — ");
            })();
            const defects = Chunk.toReadonlyArray(Cause.defects(cause));
            const defectStr = defects.length
              ? defects
                  .map((d) =>
                    d instanceof Error
                      ? `${d.name}: ${d.message}\n${d.stack ?? ""}`
                      : JSON.stringify(d, null, 2),
                  )
                  .join("\n")
              : null;
            logError(
              "PollScheduler",
              `Manual thread sync failed for PR ${prId}:`,
              [detail, defectStr, pretty].filter(Boolean).join("\n"),
            );
            return hub.broadcast({
              type: "threads:sync-error",
              data: {
                prId,
                message: detail ?? defectStr ?? pretty,
              },
            });
          }),
        ),
    };
  }),
);
