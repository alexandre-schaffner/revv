import type { PullRequest, Repository, ServerEventMessage } from "@revv/shared";
import { AUTO_FETCH_DEFAULT_INTERVAL, THREAD_SYNC_INTERVAL_SECONDS } from "@revv/shared";
import { Cause, Chunk, Context, Duration, Effect, Fiber, Layer, Ref, Schedule } from "effect";
import { repositories } from "../db/schema";
import { pullRequests } from "../db/schema/pull-requests";
import {
  DbError,
  type GitHubAuthError,
  type GitHubError,
  type NotFoundError,
  type ValidationError,
} from "../domain/errors";
import { withDb as withDbHelper } from "../effects/with-db";
import { debug, logError } from "../logger";
import { Broadcaster } from "./Broadcaster";
import { DbService } from "./Db";
import { DiffCacheService } from "./DiffCache";
import { GitHubGateway } from "./GitHub";
import { GitHubEtagCache } from "./GitHubEtagCache";
import { apiBaseForHost } from "./github-rest";
import { PullRequestService } from "./PullRequest";
import {
  broadcastToAccount as broadcastToAccountWith,
  type GitHubInfra,
  makeAccountPauses,
  openSyncCycle,
  type PollDeps,
  type SyncCycle,
} from "./poll-cycle";
import {
  backfillArchive,
  refetchDiffs,
  refreshAccountIdentities,
  refreshRepoMetadata,
} from "./poll-maintenance";
import { announceSyncChanges, collectSyncChanges } from "./poll-notifications";
import {
  archiveClosedPrs,
  findUnchangedRepos,
  type ListedSignature,
  movedRangePrIds,
  openListMoved,
  syncRepoOpenPrs,
} from "./poll-open-prs";
import { isTrustedHeadShaMove, preserveHeadOnStaleRead } from "./pr-head-move";
import { RemoteUserService } from "./RemoteUser";
import { RepoCloneService } from "./RepoClone";
import { RepositoryService } from "./Repository";
import { SettingsService } from "./Settings";
import { SyncService } from "./Sync";
import { TokenProvider } from "./TokenProvider";
import { WalkthroughService } from "./Walkthrough";
import { WalkthroughJobs } from "./WalkthroughJobs";

type PollSchedulerService = {
  readonly start: () => Effect.Effect<void>;
  readonly stop: () => Effect.Effect<void>;
  readonly restart: (intervalMinutes: number) => Effect.Effect<void>;
  /**
   * Full sync of every repo on every account. Coalesces onto an in-flight
   * cycle rather than starting a second one.
   */
  readonly syncNow: () => Effect.Effect<void>;
  /**
   * Bring the PR list up to date because a client is looking at it.
   *
   * The same cycle the poll fiber runs — notifications and auto-walkthroughs
   * included, since a change found here is one the next periodic cycle would
   * no longer see — skipped when any cycle started in the last
   * `FRESHEN_MIN_INTERVAL_MS`. Unlike {@link syncNow} it does not force a
   * `prs:updated`: the caller already holds the DB state.
   */
  readonly freshen: () => Effect.Effect<void>;
  /**
   * Re-read ONE pull request from GitHub and reconcile it.
   *
   * The targeted counterpart to {@link syncNow}: bounded to a couple of
   * requests instead of a full pass over every repo, so it is what the UI's
   * per-PR refresh should call. It also uses GitHub's PR *detail* endpoint,
   * which — unlike the list endpoint the poll runs on — carries
   * additions/deletions/changed_files, making this the path by which an open PR
   * acquires real diff stats.
   */
  readonly refreshPr: (
    prId: string,
  ) => Effect.Effect<void, NotFoundError | ValidationError | GitHubAuthError | GitHubError>;
  readonly syncThreadsNow: (prId: string) => Effect.Effect<void>;
};

export class PollScheduler extends Context.Tag("PollScheduler")<
  PollScheduler,
  PollSchedulerService
>() {}

const METADATA_REFRESH_INTERVAL_MS = 60 * 60 * 1000;
const ARCHIVE_BACKFILL_INTERVAL_MS = 60 * 60 * 1000;

/**
 * How recently a cycle must have started for `freshen` to skip. Every window
 * open and focus asks for one, so this is what keeps alt-tabbing (or several
 * windows) from becoming a cycle per event: at most one extra cycle per
 * interval, however often clients ask, and none at all while the poll
 * interval is shorter than this. Each cycle costs at least a GraphQL point
 * per account, and a full re-list a point per repo.
 */
const FRESHEN_MIN_INTERVAL_MS = 2 * 60 * 1000;

/**
 * What started a cycle. `manual` is the user's refresh button: it always
 * re-lists every repo, always answers with a `prs:updated`, and stays quiet
 * about notifications. `periodic` and `freshen` behave alike once running.
 */
type SyncTrigger = "periodic" | "manual" | "freshen";

export const PollSchedulerLive = Layer.effect(
  PollScheduler,
  Effect.gen(function* () {
    // Capture all dependencies once at layer construction time
    const broadcaster = yield* Broadcaster;
    const github = yield* GitHubGateway;
    const prService = yield* PullRequestService;
    const diffCache = yield* DiffCacheService;
    const repoService = yield* RepositoryService;
    const settingsService = yield* SettingsService;
    const syncService = yield* SyncService;
    const etagCache = yield* GitHubEtagCache;
    const walkthroughJobs = yield* WalkthroughJobs;
    const tokenProvider = yield* TokenProvider;
    const { db } = yield* DbService;
    const deps: PollDeps = {
      db,
      broadcaster,
      github,
      prService,
      remoteUserService: yield* RemoteUserService,
      diffCache,
      repoService,
      walkthroughJobs,
      walkthroughService: yield* WalkthroughService,
      repoClone: yield* RepoCloneService,
      tokenProvider,
    };

    // Bad-token and rate-limit pauses, carried from one cycle to the next.
    const accountPauses = makeAccountPauses();
    // Start at 0 so the first poll runs a metadata refresh immediately: this
    // re-signs any expired GitHub Enterprise avatar URLs and backfills the
    // cached avatar bytes (`repositories.avatar_content`) right after boot,
    // instead of leaving stale/blank icons for up to an hour.
    let lastMetadataRefreshAt = 0;
    // Seed to 0 (not `Date.now()`) so the archive backfill runs on the first
    // poll after boot rather than waiting a full interval. Without this a fresh
    // mirror shows no closed/merged PRs for the first hour, and in dev — where
    // the server restarts more often than once an hour — the backfill would
    // never run at all, leaving the archive populated only by live closures.
    let lastArchiveBackfillAt = 0;
    // The signature of each repo's last open-PR list that landed in SQLite,
    // which lets a cycle skip re-listing repos where nothing moved. A
    // reconstructible cache: empty after a restart, so the first cycle lists
    // every repo.
    const listedSignatures = new Map<string, ListedSignature>();

    // Bind the captured db handle for convenience
    const withDb = <A, E>(eff: Effect.Effect<A, E, DbService>) => withDbHelper(db, eff);

    // Provide `DbService` + `GitHubEtagCache` (both captured at layer
    // construction) so effects that transitively call `github.*` REST methods
    // — which now participate in the ETag cache — don't leak those services
    // into the public Tag signatures.
    const provideInfra = <A, E>(eff: Effect.Effect<A, E, GitHubInfra>): Effect.Effect<A, E> =>
      eff.pipe(
        Effect.provideService(DbService, { db }),
        Effect.provideService(GitHubEtagCache, etagCache),
        Effect.provideService(SettingsService, settingsService),
      );

    // Tracks whether at least one periodic sync has completed.
    // The first periodic sync is used as baseline — we don't know what
    // changed vs the prior server run, so we skip notifications for it.
    const hasPeriodicSyncedOnceRef = yield* Ref.make(false);
    const broadcastGlobal = (msg: ServerEventMessage) =>
      broadcaster.broadcastAll(msg).pipe(Effect.orElseSucceed(() => undefined));
    const broadcastToAccount = (accountId: string, msg: ServerEventMessage) =>
      broadcastToAccountWith(deps, accountId, msg);

    /**
     * Fan a data-bearing sync envelope out to every account with repos, one
     * scoped message each. `prs:sync-started` / `prs:sync-complete` carry an
     * account's open-PR count, so per `docs/conventions.md` §3 they must not go
     * out via `broadcastAll` — that leaks one account's numbers to another's
     * clients.
     */
    const broadcastPerAccount = (
      accountIds: readonly string[],
      msg: (accountId: string) => ServerEventMessage,
    ): Effect.Effect<void> =>
      Effect.forEach(accountIds, (id) => broadcastToAccount(id, msg(id)), {
        discard: true,
      });

    /**
     * Broadcast the canonical open-PR DB state per account.
     *
     * `prs:updated` is full-state, not a patch — it includes repos whose
     * GitHub fetch failed this cycle, so a client can always treat it as the
     * whole truth. That also makes it expensive: the entire PR list per
     * account, and a whole-array swap in `replacePullRequests` that re-derives
     * every sidebar filter and sort. So a cycle only sends it when it actually
     * moved something. A client that misses one still reconciles:
     * `reconcileOnReconnect` refetches via REST on every SSE (re)connect.
     */
    const broadcastOpenPrs = (accountIds: readonly string[]) =>
      Effect.forEach(
        accountIds,
        (accountId) =>
          Effect.gen(function* () {
            const accountPrs = yield* withDb(prService.listPrs(accountId));
            yield* broadcastToAccount(accountId, { type: "prs:updated", data: accountPrs });
          }),
        { discard: true },
      );

    // Fiber ref for the running poll loop — null when stopped
    const fiberRef = yield* Ref.make<Fiber.RuntimeFiber<number, never> | null>(null);

    // ── Cycle phases ──────────────────────────────────────────────────────
    // Each is one step of `syncAllRepos`, reading the cycle's account context
    // and reporting back what the next steps need.

    /**
     * Bring every repo's open PRs in SQLite up to date with GitHub. Repos the
     * signature probe proves unchanged reuse their DB rows (never on a manual
     * sync). Returns the cycle's open PRs and the repos GitHub actually listed.
     */
    const syncOpenPrLists = (
      cycle: SyncCycle,
      allRepos: readonly Repository[],
      existingPrs: readonly PullRequest[],
      existingMap: ReadonlyMap<string, PullRequest>,
      trigger: SyncTrigger,
    ): Effect.Effect<
      { readonly allPrs: PullRequest[]; readonly listedRepoIds: ReadonlySet<string> },
      DbError,
      GitHubInfra
    > =>
      Effect.gen(function* () {
        const diffStatsHeadRows = yield* Effect.try({
          try: () =>
            db
              .select({ id: pullRequests.id, headSha: pullRequests.diffStatsHeadSha })
              .from(pullRequests)
              .all(),
          catch: (cause) =>
            new DbError({ message: "Failed to read PR diff-stat watermarks", cause }),
        });

        const liveRepoIds = new Set(allRepos.map((r) => r.id));
        for (const repoId of listedSignatures.keys()) {
          if (!liveRepoIds.has(repoId)) listedSignatures.delete(repoId);
        }
        const unchangedRepoIds =
          trigger === "manual"
            ? new Set<string>()
            : yield* findUnchangedRepos(deps, cycle, allRepos, listedSignatures);

        const ctx = {
          existingMap,
          existingByRepo: Map.groupBy(existingPrs, (pr) => pr.repositoryId),
          diffStatsHeadByPrId: new Map(diffStatsHeadRows.map((row) => [row.id, row.headSha])),
          unchangedRepoIds,
          listedSignatures,
        };
        const results = yield* Effect.forEach(
          allRepos,
          (repo) => syncRepoOpenPrs(deps, cycle, ctx, repo),
          { concurrency: 3 },
        );

        return {
          allPrs: results.flatMap((r) => r?.prs ?? []),
          listedRepoIds: new Set(
            allRepos.filter((_, i) => results[i]?.listed === true).map((r) => r.id),
          ),
        };
      });

    /**
     * Settle PRs that were open before but are gone now (closed/merged on
     * GitHub). Only repos GitHub actually listed this cycle count — a repo
     * whose list failed, or was reused from the DB, keeps its rows. Returns
     * the ids of the PRs that left the open list.
     */
    const closeVanishedPrs = (
      cycle: SyncCycle,
      allRepos: readonly Repository[],
      existingPrs: readonly PullRequest[],
      allPrs: readonly PullRequest[],
      listedRepoIds: ReadonlySet<string>,
    ): Effect.Effect<string[], never, GitHubInfra> =>
      Effect.gen(function* () {
        const freshPrIdSet = new Set(allPrs.map((pr) => pr.id));
        const closedPrs = existingPrs.filter(
          (pr) =>
            pr.status === "open" && listedRepoIds.has(pr.repositoryId) && !freshPrIdSet.has(pr.id),
        );
        if (closedPrs.length > 0) {
          yield* archiveClosedPrs(deps, cycle, closedPrs, new Map(allRepos.map((r) => [r.id, r])));
        }
        return closedPrs.map((pr) => pr.id);
      });

    /**
     * Head-SHA change → walkthroughs for this PR pin to the OLD SHA and are now
     * stale. Per doctrine invariant #7 (walkthroughs are immutable per head
     * SHA), we mark them 'superseded' rather than mutate or delete. A fresh
     * walkthrough row is created on the next user-opens-PR flow for the new SHA.
     *
     * We pass the NEW headSha as `exceptHeadSha` so a walkthrough the SSE
     * handler may have just created at that SHA (the user clicked Generate
     * while this poll was mid-flight) survives — it's by definition not stale,
     * since "stale" means "pinned to an old SHA we just learned has been
     * replaced."
     *
     * `isTrustedHeadShaMove` gates that on the fresh payload actually being
     * newer than the row we already have. The list endpoint is cache-fronted
     * and lags the PR detail endpoint `refreshPr` and the walkthrough job read
     * from, so "the SHAs differ" does NOT imply "the head moved forward" — and
     * acting on a stale read here cancelled the walkthrough generating at the
     * real head and left a contentless 'superseded' row behind.
     */
    const supersedeStaleWalkthroughs = (
      allPrs: readonly PullRequest[],
      existingMap: ReadonlyMap<string, PullRequest>,
    ): Effect.Effect<void> =>
      Effect.forEach(
        allPrs,
        (pr) => {
          const existing = existingMap.get(pr.id);
          if (existing === undefined || pr.headSha === null) return Effect.void;
          if (!isTrustedHeadShaMove(existing, pr)) return Effect.void;
          return walkthroughJobs
            .supersedeForPr(pr.id, pr.headSha)
            .pipe(Effect.catchAll(() => Effect.void));
        },
        { discard: true },
      );

    /**
     * The hourly refresh of repo metadata and account identities. Returns
     * whether any repo's visible metadata changed.
     */
    const refreshMetadataIfDue = (
      cycle: SyncCycle,
      allRepos: readonly Repository[],
    ): Effect.Effect<boolean, never, GitHubInfra> =>
      Effect.gen(function* () {
        if (Date.now() - lastMetadataRefreshAt < METADATA_REFRESH_INTERVAL_MS) return false;
        lastMetadataRefreshAt = Date.now();
        const reposChanged = yield* refreshRepoMetadata(deps, cycle, allRepos);
        yield* refreshAccountIdentities(deps, cycle);
        return reposChanged;
      });

    /** The hourly archive backfill. Returns whether it added any PR. */
    const backfillArchiveIfDue = (
      cycle: SyncCycle,
      allRepos: readonly Repository[],
      existingPrs: readonly PullRequest[],
    ): Effect.Effect<boolean, never, GitHubInfra> =>
      Effect.suspend(() => {
        if (Date.now() - lastArchiveBackfillAt < ARCHIVE_BACKFILL_INTERVAL_MS) {
          return Effect.succeed(false);
        }
        lastArchiveBackfillAt = Date.now();
        return backfillArchive(deps, cycle, allRepos, existingPrs);
      });

    // The core sync effect — all services are plain values captured from the closure.
    // `GitHubInfra` remains in R because `github.*` methods depend on it
    // internally; the layer that constructs PollScheduler already has all
    // provided, so the forked fiber inherits them.
    const syncAllRepos = (trigger: SyncTrigger): Effect.Effect<void, never, GitHubInfra> =>
      Effect.withSpan("PollScheduler.syncAllRepos")(
        Effect.gen(function* () {
          // Snapshot ETag-cache counters so we can report deltas for this cycle.
          const etagStatsBefore = etagCache.stats();

          const allRepos = yield* withDb(repoService.listRepos());

          const repoRowsForAccount = db
            .select({ id: repositories.id, accountId: repositories.accountId })
            .from(repositories)
            .all();
          const repoToAccountId = new Map(repoRowsForAccount.map((r) => [r.id, r.accountId]));
          const accountIdSet = Array.from(new Set(repoRowsForAccount.map((r) => r.accountId)));
          yield* broadcastPerAccount(accountIdSet, () => ({ type: "prs:sync-started" }));

          if (allRepos.length === 0) {
            const etagStatsAfter = etagCache.stats();
            yield* broadcastPerAccount(accountIdSet, () => ({
              type: "prs:sync-complete",
              data: {
                count: 0,
                timestamp: new Date().toISOString(),
                cached: etagStatsAfter.hits304 - etagStatsBefore.hits304,
                refetched: etagStatsAfter.misses200 - etagStatsBefore.misses200,
              },
            }));
            return;
          }

          const cycle = yield* openSyncCycle(deps, accountPauses, accountIdSet, repoToAccountId);
          const isManual = trigger === "manual";
          const hasPeriodicSyncedOnce = yield* Ref.get(hasPeriodicSyncedOnceRef);

          // Pre-sync snapshot, the baseline for every "did this change?"
          // question below: which diffs to re-fetch, which walkthroughs to
          // supersede, which notifications to raise, and whether the cycle
          // produced anything worth broadcasting at all.
          const existingPrs = yield* withDb(prService.listPrs());
          const existingMap = new Map(existingPrs.map((pr) => [pr.id, pr]));
          // Taken before the lists land: the list phase drops the cached diff
          // of every PR whose range moved, and these are the ones to re-fill.
          const cachedDiffPrIds = new Set(yield* withDb(diffCache.getPrIdsWithCachedDiffs()));

          const { allPrs, listedRepoIds } = yield* syncOpenPrLists(
            cycle,
            allRepos,
            existingPrs,
            existingMap,
            trigger,
          );
          const closedPrIds = yield* closeVanishedPrs(
            cycle,
            allRepos,
            existingPrs,
            allPrs,
            listedRepoIds,
          );
          yield* supersedeStaleWalkthroughs(allPrs, existingMap);

          // The list goes out as soon as it has landed, ahead of everything
          // else the cycle does: the PR list is what a client opening the app
          // is waiting on, and none of the work below changes it. A manual
          // sync always answers, even with nothing to say: the user pressed a
          // button and the client is holding a spinner. Same for the first
          // cycle after boot, which is a client's initial hydration.
          const listChanged = closedPrIds.length > 0 || openListMoved(allPrs, existingMap);
          if (listChanged || isManual || !hasPeriodicSyncedOnce) {
            yield* broadcastOpenPrs(accountIdSet);
          }

          // Must precede the notification diff: it refreshes the account
          // logins that diff reads to decide which PRs are "for me".
          const reposChanged = yield* refreshMetadataIfDue(cycle, allRepos);

          // The first periodic sync is a baseline (we don't know what was new
          // since the prior server run) and manual syncs are diagnostic —
          // neither raises notifications or mass-spawns AI jobs.
          if (!isManual && hasPeriodicSyncedOnce && existingPrs.length > 0) {
            const outcome = { allRepos, allPrs, existingMap, closedPrIds };
            const changes = collectSyncChanges(cycle, outcome);
            if (changes.length > 0) yield* announceSyncChanges(deps, cycle, outcome, changes);
          }

          yield* refetchDiffs(
            deps,
            cycle,
            movedRangePrIds(allPrs, existingMap).filter((id) => cachedDiffPrIds.has(id)),
            new Map(allPrs.map((pr) => [pr.id, pr])),
            new Map(allRepos.map((r) => [r.id, r])),
          );
          const archiveChanged = yield* backfillArchiveIfDue(cycle, allRepos, existingPrs);

          // The maintenance passes can move what a client shows (repo avatars,
          // PRs the backfill pulled into the archive) after the list went out,
          // so they get a follow-up broadcast of their own.
          if (reposChanged || archiveChanged) yield* broadcastOpenPrs(accountIdSet);

          yield* Ref.set(hasPeriodicSyncedOnceRef, true);

          // Per-account, and with that account's own PR count: this envelope
          // carries data, so `broadcastAll` would hand account A's totals to
          // account B's clients.
          //
          // `cached` / `refetched` are process-wide conditional-request counters
          // sampled around this cycle, so they also include anything the thread
          // sweep did in the same window. They are a cache-efficiency readout,
          // not a per-cycle audit — don't derive request counts from them.
          const etagStatsAfter = etagCache.stats();
          const syncCompletedAt = new Date().toISOString();
          const cached = etagStatsAfter.hits304 - etagStatsBefore.hits304;
          const refetched = etagStatsAfter.misses200 - etagStatsBefore.misses200;
          const openPrCountByAccount = new Map<string, number>();
          for (const pr of allPrs) {
            const accountId = repoToAccountId.get(pr.repositoryId);
            if (!accountId) continue;
            openPrCountByAccount.set(accountId, (openPrCountByAccount.get(accountId) ?? 0) + 1);
          }
          yield* broadcastPerAccount(accountIdSet, (accountId) => ({
            type: "prs:sync-complete",
            data: {
              count: openPrCountByAccount.get(accountId) ?? 0,
              timestamp: syncCompletedAt,
              cached,
              refetched,
            },
          }));
        }),
      ).pipe(
        Effect.tapErrorCause((cause) =>
          Effect.sync(() => {
            logError("PollScheduler", "syncAllRepos top-level failure:", Cause.pretty(cause));
          }),
        ),
        Effect.catchAllCause((cause) =>
          broadcastGlobal({
            type: "error",
            data: { code: "SYNC_ERROR", message: String(cause) },
          }),
        ),
      );

    // One sync cycle at a time, process-wide.
    //
    // `syncNow` used to run `syncAllRepos` inline with no coordination, so a
    // manual refresh landing mid-cycle started a second full pass concurrently:
    // double the GitHub cost, both cycles racing the `lastMetadataRefreshAt` /
    // `lastArchiveBackfillAt` closure vars, and the first one to finish
    // clearing the client's spinner while the other was still running.
    //
    // Concurrent callers coalesce onto the in-flight cycle rather than queue
    // behind it — queueing would just run the duplicate pass a moment later,
    // and the in-flight cycle already broadcasts `prs:sync-complete`, so a
    // waiting client sees its refresh finish either way.
    //
    // `lastStartedAt` is `freshen`'s throttle, checked in the same atomic step
    // that claims the cycle. A coordination cache only: losing it on restart
    // lets one extra freshen through.
    const cycleGateRef = yield* Ref.make({ inFlight: false, lastStartedAt: 0 });

    const runSyncOnce = (trigger: SyncTrigger): Effect.Effect<void, never, GitHubInfra> =>
      Effect.gen(function* () {
        const claim = yield* Ref.modify(cycleGateRef, (gate) => {
          const now = Date.now();
          if (gate.inFlight) return ["in-flight" as const, gate];
          if (trigger === "freshen" && now - gate.lastStartedAt < FRESHEN_MIN_INTERVAL_MS) {
            return ["fresh-enough" as const, gate];
          }
          return ["claimed" as const, { inFlight: true, lastStartedAt: now }];
        });
        if (claim === "in-flight") {
          debug("PollScheduler", "sync already in flight — coalescing this request");
          return;
        }
        if (claim === "fresh-enough") return;
        yield* syncAllRepos(trigger).pipe(
          Effect.ensuring(Ref.update(cycleGateRef, (gate) => ({ ...gate, inFlight: false }))),
        );
      });

    /**
     * Reconcile a single PR against GitHub's PR *detail* endpoint.
     *
     * Repeats the poll's follow-through on a head-SHA move — invalidate the
     * cached diff, supersede walkthroughs pinned to the old SHA — because
     * without it a refresh would leave the UI showing a new head SHA against
     * the previous commit's diff.
     */
    const refreshPr = (
      prId: string,
    ): Effect.Effect<
      void,
      NotFoundError | ValidationError | GitHubAuthError | GitHubError,
      DbService | GitHubEtagCache | SettingsService
    > =>
      Effect.gen(function* () {
        const existing = yield* withDb(prService.getPr(prId));
        const repo = yield* withDb(repoService.getRepoById(existing.repositoryId));
        const accountId = yield* withDb(repoService.getAccountIdForRepo(repo.id));
        const token = yield* tokenProvider.getTokenByAccountId(accountId);

        const fresh = yield* github.prs.get(
          repo.fullName,
          existing.externalId,
          token,
          apiBaseForHost(repo.githubHost),
        );
        // `getPr` derives id/repositoryId from `owner/repo` because it has no
        // idea what our local row is called. Repoint before writing.
        // Same stale-read masking as the list poll: a detail read can lag too
        // (the ETag cache in front of it will replay a body that was already
        // stale when cached), and writing a regressed head here is what makes
        // the guard below self-defeating on the next cycle.
        const row = preserveHeadOnStaleRead(existing, {
          ...fresh,
          id: existing.id,
          repositoryId: existing.repositoryId,
        });
        // Same stale-read guard as the list poll: only treat the head as moved
        // when the detail payload is provably a newer view of the PR than the
        // row we had. Without it a lagging read cancels the walkthrough
        // generating at the real head.
        const headMoved = row.headSha !== null && isTrustedHeadShaMove(existing, row);
        // Drop the old head's diff before the new head lands, so nothing can
        // read the new head against it (see `syncRepoOpenPrs`).
        if (headMoved) yield* withDb(diffCache.invalidateFiles(prId));
        yield* withDb(prService.upsertPrs([row]));
        if (headMoved && row.headSha !== null) {
          yield* walkthroughJobs
            .supersedeForPr(prId, row.headSha)
            .pipe(Effect.catchAll(() => Effect.void));
        }

        if (row.status !== "open") {
          yield* broadcastToAccount(accountId, {
            type: "pr:archived",
            data: {
              prId: row.id,
              repoId: row.repositoryId,
              status: row.status === "merged" ? "merged" : "closed",
              closedAt: row.closedAt ?? new Date().toISOString(),
            },
          });
        }

        const accountPrs = yield* withDb(prService.listPrs(accountId));
        yield* broadcastToAccount(accountId, { type: "prs:updated", data: accountPrs });
      });

    const stopFiber: Effect.Effect<void> = Effect.gen(function* () {
      const fiber = yield* Ref.get(fiberRef);
      if (fiber !== null) {
        yield* Fiber.interrupt(fiber).pipe(Effect.asVoid);
        yield* Ref.set(fiberRef, null);
      }
    });

    // ── Thread sync loop ──────────────────────────────────────────────────
    // Separate fiber that periodically reconciles threads for open PRs.
    // Opening a PR triggers an immediate targeted sync, so this background
    // sweep stays intentionally slow to avoid GitHub rate-limit bursts.
    const threadFiberRef = yield* Ref.make<Fiber.RuntimeFiber<number, never> | null>(null);

    // `pr.updatedAt` as of the last sweep that reconciled this PR. Purely a
    // cost optimisation and fully reconstructible — losing it on restart just
    // means one extra sweep per PR.
    const lastThreadSweepUpdatedAt = new Map<string, string>();

    const syncThreadsForOpenPrs: Effect.Effect<void> = Effect.gen(function* () {
      const prs = yield* withDb(prService.listPrs()).pipe(
        Effect.orElseSucceed(() => [] as PullRequest[]),
      );
      const openPrs = prs.filter((p) => p.status === "open");

      // Narrow to the PRs that can actually have moved.
      //
      // GitHub bumps `updated_at` when a review comment is added, edited, or
      // deleted, so an unchanged `updated_at` means no comment activity. The one
      // thing it does NOT cover is a resolve/unresolve, which changes thread
      // state without touching the PR — so any PR that still has an unresolved
      // local thread is always swept.
      //
      // This matters because the reconcile needs a GraphQL call, and GraphQL has
      // no conditional-request equivalent: unlike the REST half of the sweep,
      // where a 304 is free, every one of those is billed. Sweeping every open
      // PR every tick made the GraphQL fan-out scale with the size of the PR
      // list rather than with the set of PRs anyone is actually reviewing.
      const candidates: PullRequest[] = [];
      for (const pr of openPrs) {
        const lastSeen = lastThreadSweepUpdatedAt.get(pr.id);
        if (lastSeen === undefined || lastSeen !== pr.updatedAt) {
          candidates.push(pr);
          continue;
        }
        const summary = yield* withDb(syncService.getThreadSummary(pr.id, null)).pipe(
          Effect.orElseSucceed(() => null),
        );
        if (summary === null || summary.total > summary.resolved) candidates.push(pr);
      }

      const skipped = openPrs.length - candidates.length;
      if (skipped > 0) {
        debug(
          "PollScheduler",
          `thread sweep: ${candidates.length}/${openPrs.length} PRs need a reconcile (${skipped} unchanged and fully resolved)`,
        );
      }

      // Sequential on purpose: each PR-sync is lightweight (REST + a small
      // GraphQL call), and running them concurrently is what trips GitHub's
      // secondary (abuse) rate limit.
      yield* Effect.forEach(
        candidates,
        (pr) =>
          provideInfra(syncService.syncThreads(pr.id)).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                lastThreadSweepUpdatedAt.set(pr.id, pr.updatedAt);
              }),
            ),
            Effect.asVoid,
            Effect.catchAllCause((cause) =>
              Effect.sync(() => {
                // Leave the watermark alone on failure so the next sweep retries
                // this PR instead of assuming it is up to date.
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

      // Drop watermarks for PRs that are no longer open so the map can't grow
      // without bound across a long-running process.
      if (lastThreadSweepUpdatedAt.size > openPrs.length) {
        const openIds = new Set(openPrs.map((p) => p.id));
        for (const id of lastThreadSweepUpdatedAt.keys()) {
          if (!openIds.has(id)) lastThreadSweepUpdatedAt.delete(id);
        }
      }
    }).pipe(
      Effect.catchAllCause((cause) =>
        broadcastGlobal({
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
      // Delay the FIRST background thread sweep by one interval. At boot the
      // PR-sync fiber already fires immediately (repo metadata + user avatars +
      // listOpen per repo + archive backfill), and running the all-open-PRs
      // thread sweep concurrently on top of that produces a request burst that
      // trips GitHub's *secondary* (abuse) rate limit — the "rate limited as
      // soon as I open Revv" symptom, made worse when an IDE shares the
      // account. Opening a PR force-syncs its threads on demand, so this delay
      // never affects the PR the user is actually looking at.
      const fiber: Fiber.RuntimeFiber<number, never> = yield* Effect.fork(
        syncThreadsForOpenPrs.pipe(
          Effect.repeat(schedule),
          Effect.delay(Duration.seconds(THREAD_SYNC_INTERVAL_SECONDS)),
        ),
      );
      yield* Ref.set(threadFiberRef, fiber);
    });

    const startWithInterval = (intervalMinutes: number): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (intervalMinutes <= 0) return;
        // Run immediately on start, then repeat at the given interval
        const schedule = Schedule.spaced(Duration.minutes(intervalMinutes));
        const fiber: Fiber.RuntimeFiber<number, never> = yield* Effect.fork(
          provideInfra(runSyncOnce("periodic").pipe(Effect.repeat(schedule))),
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

      syncNow: () => provideInfra(runSyncOnce("manual")),

      freshen: () => provideInfra(runSyncOnce("freshen")),

      refreshPr: (prId) => provideInfra(refreshPr(prId)),

      // `force: true` — a user-initiated sync must emit `threads:synced` even
      // when nothing changed, because that envelope is what clears the client's
      // per-PR spinner. Only the background sweep stays quiet on no-ops.
      syncThreadsNow: (prId: string) =>
        provideInfra(syncService.syncThreads(prId, { force: true })).pipe(
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
            const userMessage = detail ?? "Unknown error";
            return Effect.gen(function* () {
              const prRow = yield* withDb(prService.getPr(prId)).pipe(
                Effect.catchAll(() => Effect.succeed(null)),
              );
              if (!prRow) return;
              const accountId = yield* withDb(
                repoService.getAccountIdForRepo(prRow.repositoryId),
              ).pipe(Effect.catchAll(() => Effect.succeed(null)));
              if (!accountId) return;
              yield* broadcaster
                .broadcastToAccount(accountId, {
                  type: "threads:sync-error",
                  data: { prId, message: userMessage },
                })
                .pipe(Effect.orElseSucceed(() => undefined));
            });
          }),
        ),
    };
  }),
);
