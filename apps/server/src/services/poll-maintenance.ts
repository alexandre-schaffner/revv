/**
 * The maintenance phases of `PollScheduler.syncAllRepos` — work that runs
 * after the open-PR list has gone out, because nothing on screen waits on it.
 */
import type { PullRequest, Repository } from "@revv/shared";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { account, user } from "../db/schema/auth";
import { withDb } from "../effects/with-db";
import { logError } from "../logger";
import { apiBaseForHost } from "./github-rest";
import type { GitHubInfra, PollDeps, SyncCycle } from "./poll-cycle";
import type { SettingsService } from "./Settings";

const ARCHIVE_BACKFILL_DAYS = 7;
/**
 * Sized to cover the full backfill window in a single cycle for an active repo
 * (~13 closed PRs/day × 7 days ≈ 90, with headroom). The search returns the
 * whole window; this caps how many missing rows we individually fetch per repo
 * per cycle. At 25 a busy repo only imported ~2 days per cycle, so a fresh
 * mirror never showed the whole week. Only ever fetches PRs not already
 * mirrored, so the cost is a bounded one-time burst that converges to
 * near-zero.
 */
const ARCHIVE_BACKFILL_MAX_FETCHES_PER_REPO = 150;

/**
 * Refresh repo metadata (avatar URL, default branch), broadcasting
 * `repos:updated` to each account whose repos changed. Returns whether any
 * repo's visible metadata changed.
 *
 * Bypasses the ETag cache — some GitHub Enterprise instances return signed
 * `avatar_url`s whose token expires without invalidating the endpoint's ETag,
 * so a plain `getRepo` would replay the stale body. Repo creation and login
 * paths already hydrate these values; this pass is maintenance for expiring
 * GitHub Enterprise avatar URLs.
 */
export const refreshRepoMetadata = (
  deps: PollDeps,
  cycle: SyncCycle,
  repos: readonly Repository[],
): Effect.Effect<boolean, never, GitHubInfra> =>
  Effect.gen(function* () {
    const { db, github, repoService } = deps;
    let anyRepoChanged = false;
    yield* Effect.forEach(
      repos,
      (repo) =>
        Effect.gen(function* () {
          const live = cycle.liveAccountForRepo(repo.id, "core");
          if (!live) return;
          const fresh = yield* cycle.tryGuarded(
            live.acc,
            github.repos.getFresh(repo.fullName, live.token, apiBaseForHost(repo.githubHost)),
          );
          if (!fresh) return;
          // Always hand the fresh metadata to the service — it owns the change
          // detection (the served `avatarUrl` is the cached data URL, so a
          // raw-URL comparison here would never match). It re-fetches the
          // avatar bytes only when the raw URL rotated or was never cached,
          // then returns the updated repo. Broadcast only when the
          // externally-visible value actually changed.
          const updated = yield* withDb(
            db,
            repoService.updateRepoMetadata(repo.id, {
              avatarUrl: fresh.avatarUrl,
              defaultBranch: fresh.defaultBranch,
            }),
          ).pipe(Effect.orElseSucceed(() => null));
          if (
            updated &&
            (updated.avatarUrl !== repo.avatarUrl || updated.defaultBranch !== repo.defaultBranch)
          ) {
            anyRepoChanged = true;
          }
        }).pipe(Effect.orElseSucceed(() => undefined)),
      { concurrency: 3 },
    );

    if (anyRepoChanged) {
      const refreshedRepos = yield* withDb(db, repoService.listRepos());
      // Group by account and broadcast per-account so each connected client
      // only receives repos for the account it is authenticated against.
      const reposByAccount = Map.groupBy(
        refreshedRepos,
        (r) => cycle.repoToAccountId.get(r.id) ?? "unknown",
      );
      for (const [accountId, accountRepos] of reposByAccount) {
        yield* deps.broadcaster.broadcastToAccount(accountId, {
          type: "repos:updated",
          data: accountRepos,
        });
      }
    }
    return anyRepoChanged;
  });

/**
 * Refresh each account's avatar + githubLogin, mirroring them onto the `user`
 * row and into `cycle.accountById`.
 *
 * Same rationale as {@link refreshRepoMetadata}: GitHub Enterprise signed
 * `avatar_url`s on the /user endpoint expire without the ETag changing, so a
 * cached response replays a dead token. Bypassing the ETag cache keeps the
 * stored avatar URLs fresh so sidebars, comment headers, and the settings page
 * don't render broken avatars after the signed URL rotates.
 *
 * Per ACCOUNT (not "the first user") because each account has its own OAuth
 * identity — github_login + avatar_url live on the `account` row, and the
 * connected client's SSE stream is account-scoped. The `user.image` mirror is
 * updated to the avatar of one of the user's accounts so existing code that
 * reads `user.image` keeps working.
 */
export const refreshAccountIdentities = (
  deps: PollDeps,
  cycle: SyncCycle,
): Effect.Effect<void, never, SettingsService> =>
  Effect.forEach(
    cycle.accountRows,
    (acc) =>
      Effect.gen(function* () {
        const { db, github, broadcaster } = deps;
        const live = cycle.liveAccount(acc, "core");
        if (!live) return;
        // ...ForHost, not the settings-derived variant: each account carries
        // its own `providerId` host, so resolving the API base from the single
        // global settings row would send a GitHub Enterprise token to
        // api.github.com as soon as two hosts are connected on this machine.
        const fresh = yield* cycle.tryGuarded(
          live.acc,
          github.users.authenticatedFreshForHost(live.token, live.acc.host),
        );
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

        // Keep the in-memory map coherent for the rest of this cycle: the
        // notification diff, which `syncAllRepos` runs after this phase, reads
        // the account's `githubLogin` to decide which PRs are "for me".
        cycle.accountById.set(acc.id, {
          ...acc,
          avatarUrl: fresh.avatarUrl,
          githubLogin: fresh.login,
        });

        // Mirror to the user row so existing code that reads `user.image` /
        // `user.github_login` keeps working. Only touch the row if our values
        // actually differ.
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

        // Broadcast scoped to this account's SSE clients so only the sessions
        // actually authenticated against `acc` see the avatar swap. The full
        // broadcast path would leak A's avatar to B.
        yield* broadcaster.broadcastToAccount(acc.id, {
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
    { concurrency: 3, discard: true },
  );

/**
 * Re-fill the cached diffs the list phase dropped when their PR's range moved.
 * Sequential, to avoid rate-limit bursts.
 */
export const refetchDiffs = (
  deps: PollDeps,
  cycle: SyncCycle,
  prIds: readonly string[],
  prById: ReadonlyMap<string, PullRequest>,
  repoById: ReadonlyMap<string, Repository>,
): Effect.Effect<void, never, GitHubInfra> =>
  Effect.forEach(
    prIds,
    (prId) =>
      Effect.gen(function* () {
        const pr = prById.get(prId);
        if (!pr) return;

        const repo = repoById.get(pr.repositoryId);
        if (!repo) return;

        // No account row, token in the known-bad guard, or REST paused → skip
        // silently; the per-account log already covered it.
        const live = cycle.liveAccountForRepo(repo.id, "core");
        if (!live) return;

        const fileList = yield* cycle.tryGuarded(
          live.acc,
          deps.github.prs.files(
            repo.fullName,
            pr.externalId,
            live.token,
            apiBaseForHost(repo.githubHost),
          ),
        );
        if (!fileList) return;

        const files = fileList.map((f) => ({
          path: f.filename,
          oldPath: f.previousFilename,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          patch: f.patch,
          fetchedAt: new Date().toISOString(),
        }));

        // `cacheFiles` also records the PR's real diff size from this list.
        yield* withDb(deps.db, deps.diffCache.cacheFiles(prId, files)).pipe(
          Effect.orElseSucceed(() => undefined),
        );
      }).pipe(Effect.orElseSucceed(() => undefined)),
    { concurrency: 1, discard: true },
  );

/**
 * Catch closed/merged PRs that never made it into the local mirror — e.g.
 * closed before the user added the repo to Revv, or while the server was
 * offline for longer than one poll interval. Bounded to the same 7-day window
 * the DbMaintenance sweep uses for retention, so the local archive converges on
 * "last week of activity" from GitHub. Per-repo fetch cap defends against
 * bursty repos. Failures are non-fatal — we degrade silently to whatever the
 * local mirror already has.
 *
 * Returns whether any PR was added to the archive.
 */
export const backfillArchive = (
  deps: PollDeps,
  cycle: SyncCycle,
  repos: readonly Repository[],
  existingPrs: readonly PullRequest[],
): Effect.Effect<boolean, never, GitHubInfra> =>
  Effect.gen(function* () {
    const { db, github, prService } = deps;
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

    let upserted = 0;
    yield* Effect.forEach(
      repos,
      (repo) =>
        Effect.gen(function* () {
          const live = cycle.liveAccountForRepo(repo.id, "search");
          if (!live) return;

          const repoApiBase = apiBaseForHost(repo.githubHost);
          const searched = yield* cycle.tryGuarded(
            live.acc,
            github.prs.searchClosedInWindow(
              repo.fullName,
              backfillSinceIso,
              backfillUntilIso,
              live.token,
              repoApiBase,
            ),
            { errorLabel: `archive backfill search failed for ${repo.fullName}` },
          );
          if (!searched || searched.length === 0) return;

          const known = existingExternalIdsByRepo.get(repo.id) ?? new Set<number>();
          const missing = searched
            .filter((s) => !known.has(s.number))
            .slice(0, ARCHIVE_BACKFILL_MAX_FETCHES_PER_REPO);
          if (missing.length === 0) return;
          // The detail fetches below are REST, a different budget from search.
          if (!cycle.liveAccountForRepo(repo.id, "core")) return;

          const fetched = yield* Effect.forEach(
            missing,
            (m) =>
              cycle.tryGuarded(
                live.acc,
                github.prs.get(repo.fullName, m.number, live.token, repoApiBase),
              ),
            { concurrency: 3 },
          );

          // Repoint every fetched row at our local repo id — `getPr` derives
          // `id` and `repositoryId` from `${owner}/${repo}` because it doesn't
          // know the local row id. Matches the recap-jobs backfill (see
          // ProjectRecapJobs.backfillMissingPrs).
          const upsertable = fetched
            .filter((pr): pr is NonNullable<typeof pr> => pr !== null)
            .map((pr) => ({
              ...pr,
              id: `${repo.id}:${pr.externalId}`,
              repositoryId: repo.id,
            }));
          if (upsertable.length === 0) return;

          yield* withDb(db, prService.upsertPrs(upsertable)).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                upserted += upsertable.length;
              }),
            ),
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
    return upserted > 0;
  });
