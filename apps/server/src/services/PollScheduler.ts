import type { PullRequest, Repository, ServerEventMessage } from "@revv/shared";
import { THREAD_SYNC_INTERVAL_SECONDS } from "@revv/shared";
import { Cause, Context, Duration, Effect, Layer, Schedule, Stream } from "effect";
import {
  type DbError,
  type GitHubAuthError,
  type GitHubError,
  NotFoundError,
  SyncError,
} from "../domain/errors";
import { makeRestartableLoop } from "../effects/restartable-loop";
import { withDb as withDbHelper } from "../effects/with-db";
import { debug, logError } from "../logger";
import { withGitHubOrigin } from "../observability/github-ledger/origin";
import { DbService } from "./Db";
import { DiffCacheService } from "./DiffCache";
import { GitHubAccounts } from "./github/accounts";
import { AvatarCache } from "./github/avatars";
import { GitHubGateway } from "./github/gateway";
import { PrContextService } from "./PrContext";
import { PrMirror } from "./PrMirror";
import { PullRequestService } from "./PullRequest";
import { type AccountGate, openGate } from "./poll-gate";
import {
  backfillArchive,
  refetchDiffs,
  refreshAccountIdentities,
  refreshRepoMetadata,
} from "./poll-maintenance";
import { announceSyncChanges, type CycleViewers, collectSyncChanges } from "./poll-notifications";
import {
  movedRangePrIds,
  openListMoved,
  probeRepos,
  settleVanishedPrs,
  syncRepoOpenPrs,
} from "./poll-open-prs";
import { makePollState, type SyncTrigger } from "./poll-state";
import { Realtime } from "./Realtime";
import { RepositoryService } from "./Repository";
import { SettingsService } from "./Settings";
import { SyncService } from "./Sync";
import { WalkthroughService } from "./Walkthrough";
import { WalkthroughJobs } from "./WalkthroughJobs";

type PollSchedulerService = {
  readonly start: () => Effect.Effect<void>;
  /**
   * Full sync of every repo on every account. A request made while a cycle
   * is in flight runs once that cycle ends, instead of starting a second one
   * alongside it.
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
   * Re-read one PR from GitHub: what the UI's per-PR refresh calls instead of
   * {@link syncNow}. GitHub's PR detail endpoint, unlike the list endpoint the
   * poll runs on, carries additions/deletions/changed_files, so this is how an
   * open PR gets real diff stats.
   */
  readonly refreshPr: (
    prId: string,
  ) => Effect.Effect<void, NotFoundError | DbError | GitHubAuthError | GitHubError | SyncError>;
  readonly syncThreadsNow: (prId: string) => Effect.Effect<void>;
};

export class PollScheduler extends Context.Service<PollScheduler, PollSchedulerService>()(
  "PollScheduler",
) {}

const METADATA_REFRESH_INTERVAL_MS = 60 * 60 * 1000;
const ARCHIVE_BACKFILL_INTERVAL_MS = 60 * 60 * 1000;
const THREAD_SWEEP_MAX_PRS = 20;

export const PollSchedulerLive = Layer.effect(
  PollScheduler,
  Effect.gen(function* () {
    const realtime = yield* Realtime;
    const github = yield* GitHubGateway;
    const accounts = yield* GitHubAccounts;
    const prService = yield* PullRequestService;
    const prContext = yield* PrContextService;
    const diffCache = yield* DiffCacheService;
    const repoService = yield* RepositoryService;
    const settingsService = yield* SettingsService;
    const syncService = yield* SyncService;
    const walkthroughJobs = yield* WalkthroughJobs;
    const walkthroughService = yield* WalkthroughService;
    const mirror = yield* PrMirror;
    const avatars = yield* AvatarCache;
    const { db } = yield* DbService;
    const withDb = <A, E>(eff: Effect.Effect<A, E, DbService>) => withDbHelper(db, eff);

    const state = makePollState();

    /** The sync-lifecycle signals go only to the accounts the cycle syncs. */
    const broadcastPerAccount = (
      accountIds: readonly string[],
      msg: ServerEventMessage,
    ): Effect.Effect<void> =>
      Effect.forEach(accountIds, (id) => realtime.toAccount(id, msg), { discard: true });

    const viewersOf = (gate: AccountGate): Effect.Effect<CycleViewers> =>
      Effect.gen(function* () {
        const viewerLoginByAccount = new Map<string, string | null>();
        for (const accountId of gate.accountIds) {
          viewerLoginByAccount.set(
            accountId,
            yield* accounts.viewerLogin(accountId).pipe(Effect.orElseSucceed(() => null)),
          );
        }
        return { repoToAccountId: gate.repoToAccountId, viewerLoginByAccount };
      });

    /**
     * Bring every repo's open PRs in SQLite up to date with GitHub. Repos the
     * signature probe proves unchanged reuse their DB rows (never on a manual
     * sync). Returns the cycle's open PRs and the repos GitHub actually listed.
     */
    const syncOpenPrLists = (
      gate: AccountGate,
      allRepos: readonly Repository[],
      existingPrs: readonly PullRequest[],
      existingMap: ReadonlyMap<string, PullRequest>,
      trigger: SyncTrigger,
    ) =>
      Effect.gen(function* () {
        state.keepListingsFor(new Set(allRepos.map((r) => r.id)));
        const probed = yield* probeRepos(github, gate, state, allRepos, trigger !== "manual");
        const ctx = {
          existingMap,
          existingByRepo: Map.groupBy(existingPrs, (pr) => pr.repositoryId),
          diffStatsHeadByPrId: yield* withDb(prService.diffStatsHeads()),
          unchangedRepoIds: probed.unchanged,
          probedSignatures: probed.signatures,
        };
        const results = yield* Effect.forEach(
          allRepos,
          (repo) => syncRepoOpenPrs({ github, mirror, avatars }, gate, state, ctx, repo),
          { concurrency: 3 },
        );
        return {
          allPrs: results.flatMap((r) => r?.prs ?? []),
          listedRepoIds: new Set(
            allRepos.filter((_, i) => results[i]?.listed === true).map((r) => r.id),
          ),
        };
      });

    const syncCycle = (
      trigger: SyncTrigger,
      repoToAccountId: ReadonlyMap<string, string>,
      accountIds: readonly string[],
    ) =>
      Effect.gen(function* () {
        const allRepos = yield* withDb(repoService.listRepos());
        if (allRepos.length === 0) return;

        const gate = yield* openGate(accounts, repoToAccountId);
        const isManual = trigger === "manual";
        const baselineDone = state.baselineDone();

        // The baseline every "did this change?" below reads: which diffs to
        // re-fill, which notifications to raise, whether to broadcast.
        const existingPrs = yield* withDb(prService.listPrs());
        const existingMap = new Map(existingPrs.map((pr) => [pr.id, pr]));
        // Taken before the lists land: a moved PR's cached diff is stale.
        const cachedDiffPrIds = new Set(yield* diffCache.getPrIdsWithCachedDiffs());

        const { allPrs, listedRepoIds } = yield* syncOpenPrLists(
          gate,
          allRepos,
          existingPrs,
          existingMap,
          trigger,
        );
        // Only a repo GitHub listed this cycle can prove a PR left it.
        const fresh = new Set(allPrs.map((pr) => pr.id));
        const vanished = existingPrs.filter(
          (pr) => pr.status === "open" && listedRepoIds.has(pr.repositoryId) && !fresh.has(pr.id),
        );
        const repoById = new Map(allRepos.map((r) => [r.id, r]));
        const closedPrIds =
          vanished.length === 0
            ? []
            : yield* settleVanishedPrs({ github, mirror }, gate, vanished, repoById, existingMap);

        // The list goes out as soon as it has landed: it's what a client
        // opening the app waits on. A manual sync and the first cycle after
        // boot always answer, even with nothing new.
        const listChanged = closedPrIds.length > 0 || openListMoved(allPrs, existingMap);
        if (listChanged || isManual || !baselineDone) yield* mirror.announce(accountIds);

        let reposChanged = false;
        if (state.claimDue("metadata", METADATA_REFRESH_INTERVAL_MS, Date.now())) {
          reposChanged = yield* refreshRepoMetadata(
            { db, github, repoService, avatars, realtime },
            gate,
            allRepos,
          );
          yield* refreshAccountIdentities({ github, accounts }, gate);
        }

        // The first periodic cycle is a baseline and a manual one is
        // diagnostic: neither raises notifications or starts AI jobs.
        if (!isManual && baselineDone && existingPrs.length > 0) {
          const outcome = { allRepos, allPrs, existingMap, closedPrIds };
          const viewers = yield* viewersOf(gate);
          const changes = collectSyncChanges(viewers, outcome);
          if (changes.length > 0) {
            yield* announceSyncChanges(
              { db, realtime, walkthroughService, walkthroughJobs },
              viewers,
              outcome,
              changes,
            );
          }
        }

        const prById = new Map(allPrs.map((pr) => [pr.id, pr]));
        yield* refetchDiffs(
          diffCache,
          gate,
          movedRangePrIds(allPrs, existingMap).flatMap((id) => {
            const pr = prById.get(id);
            return pr && cachedDiffPrIds.has(id) ? [pr] : [];
          }),
          repoById,
        );
        const archiveChanged = state.claimDue(
          "archive-backfill",
          ARCHIVE_BACKFILL_INTERVAL_MS,
          Date.now(),
        )
          ? yield* backfillArchive({ db, github, prService, mirror }, gate, allRepos)
          : false;

        // Repo avatars and backfilled archive PRs land after the list went out.
        if (reposChanged || archiveChanged) yield* mirror.announce(accountIds);

        state.markBaselineDone();
      });

    const syncAllRepos = (trigger: SyncTrigger): Effect.Effect<void> =>
      Effect.withSpan("PollScheduler.syncAllRepos")(
        Effect.gen(function* () {
          const repoToAccountId = yield* withDb(repoService.accountIdsByRepo());
          const accountIds = [...new Set(repoToAccountId.values())];
          yield* broadcastPerAccount(accountIds, { type: "prs:sync-started" });
          yield* syncCycle(trigger, repoToAccountId, accountIds).pipe(
            Effect.andThen(broadcastPerAccount(accountIds, { type: "prs:sync-complete" })),
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                logError("PollScheduler", "sync cycle failed:", Cause.pretty(cause));
                yield* broadcastPerAccount(accountIds, {
                  type: "prs:sync-failed",
                  data: { message: "Syncing pull requests from GitHub failed" },
                });
              }),
            ),
          );
        }),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() =>
            logError("PollScheduler", "reading the repos to sync failed:", Cause.pretty(cause)),
          ),
        ),
      );

    // One cycle at a time, process-wide: concurrent callers coalesce onto the
    // one in flight, which broadcasts `prs:sync-complete` for them too.
    const runSyncOnce = (trigger: SyncTrigger): Effect.Effect<void> =>
      Effect.suspend(() => {
        const claim = state.claimCycle(trigger, Date.now());
        if (claim === "in-flight") {
          debug("PollScheduler", "sync already in flight — coalescing this request");
          return Effect.void;
        }
        if (claim === "fresh-enough") return Effect.void;
        let rerun = false;
        return syncAllRepos(trigger).pipe(
          withGitHubOrigin(`poll:sync:${trigger}`),
          Effect.ensuring(
            Effect.sync(() => {
              rerun = state.releaseCycle();
            }),
          ),
          Effect.andThen(Effect.suspend(() => (rerun ? runSyncOnce("manual") : Effect.void))),
        );
      });

    const refreshPr = (prId: string) =>
      Effect.gen(function* () {
        const { pr, repo, accountId } = yield* prContext.forPr(prId);
        const client = yield* accounts.backgroundClient(accountId, "core");
        if (client === null) {
          return yield* Effect.fail(
            new SyncError({
              message: "GitHub sync is paused for this account (sign-in needed or rate limited)",
            }),
          );
        }
        const fresh = yield* github.prs.get(client, repo.fullName, repo.id, pr.externalId);
        yield* mirror.apply([fresh], { prior: new Map([[pr.id, pr]]) });
      });

    // Opening a PR syncs its threads on demand, so this background sweep stays
    // slow to keep clear of GitHub's rate limits.
    const threadLoop = yield* makeRestartableLoop;

    const syncThreadsForOpenPrs: Effect.Effect<void> = Effect.gen(function* () {
      const openPrs = (yield* withDb(prService.listPrs())).filter((p) => p.status === "open");
      const repoToAccountId = yield* withDb(repoService.accountIdsByRepo());
      const callable = new Map<string, boolean>();
      for (const accountId of new Set(repoToAccountId.values())) {
        callable.set(accountId, (yield* accounts.backgroundClient(accountId, "core")) !== null);
      }

      // GitHub bumps `updated_at` on comment activity but not on a
      // resolve/unresolve, so an unchanged PR is re-read only now and then
      // (`rankThreadSweep`). The reconcile needs GraphQL, which has no free
      // conditional request: sweeping every open PR every tick would bill
      // the whole list.
      const now = Date.now();
      const candidates: PullRequest[] = [];
      for (const { pr, recheck } of state.sweepOrder(openPrs, now)) {
        if (candidates.length >= THREAD_SWEEP_MAX_PRS) break;
        const accountId = repoToAccountId.get(pr.repositoryId);
        if (accountId === undefined || callable.get(accountId) !== true) continue;
        if (recheck) {
          const summary = yield* withDb(syncService.getThreadSummary(pr.id)).pipe(
            Effect.orElseSucceed(() => null),
          );
          if (summary !== null && summary.total === summary.resolved) {
            state.noteSwept(pr, now);
            continue;
          }
        }
        candidates.push(pr);
      }
      if (candidates.length < openPrs.length) {
        debug(
          "PollScheduler",
          `thread sweep: reconciling ${candidates.length}/${openPrs.length} open PRs`,
        );
      }

      yield* Effect.forEach(
        candidates,
        (pr) =>
          withDb(syncService.syncThreads(pr.id)).pipe(
            Effect.tap(() => Effect.sync(() => state.noteSwept(pr, Date.now()))),
            // A failed PR keeps its mark, so the next sweep retries it.
            Effect.catchCause((cause) =>
              Effect.sync(() =>
                logError(
                  "PollScheduler",
                  `Thread sync failed for PR ${pr.id}:`,
                  Cause.pretty(cause),
                ),
              ),
            ),
          ),
        { concurrency: 1, discard: true },
      );
      state.keepSweptFor(new Set(openPrs.map((p) => p.id)));
    }).pipe(
      // The next tick retries; per-PR failures are already logged above.
      Effect.catchCause((cause) =>
        Effect.sync(() => logError("PollScheduler", "thread sweep failed:", Cause.pretty(cause))),
      ),
      withGitHubOrigin("poll:threads"),
    );

    // The first sweep waits one interval: at boot the PR-sync fiber already
    // fires a burst (metadata, avatars, every list, the archive backfill), and
    // a concurrent sweep on top of it trips GitHub's secondary rate limit.
    const threadSweepLoop = syncThreadsForOpenPrs.pipe(
      Effect.repeat(Schedule.spaced(Duration.seconds(THREAD_SYNC_INTERVAL_SECONDS))),
      Effect.delay(Duration.seconds(THREAD_SYNC_INTERVAL_SECONDS)),
    );

    const syncLoop = yield* makeRestartableLoop;
    const startSyncLoop = (intervalMinutes: number): Effect.Effect<void> =>
      intervalMinutes <= 0
        ? Effect.void
        : syncLoop.start(
            runSyncOnce("periodic").pipe(
              Effect.repeat(Schedule.spaced(Duration.minutes(intervalMinutes))),
            ),
          );

    // A new interval takes effect at once: the loop restarts, syncing now.
    yield* Effect.forkScoped(
      settingsService
        .watch((s) => s.autoFetchInterval)
        .pipe(
          Stream.runForEach((minutes) =>
            Effect.gen(function* () {
              yield* syncLoop.stop;
              yield* startSyncLoop(minutes);
            }),
          ),
        ),
    );

    return {
      start: () =>
        Effect.gen(function* () {
          if (!(yield* syncLoop.isRunning)) {
            yield* startSyncLoop((yield* settingsService.getSettings()).autoFetchInterval);
          }
          yield* threadLoop.start(threadSweepLoop);
        }),

      syncNow: () => runSyncOnce("manual"),

      freshen: () => runSyncOnce("freshen"),

      refreshPr: (prId) => refreshPr(prId).pipe(withGitHubOrigin(`poll:refresh-pr`)),

      syncThreadsNow: (prId: string) =>
        withDb(syncService.syncThreads(prId, { force: true })).pipe(
          Effect.asVoid,
          Effect.catch((err) =>
            err.cause instanceof NotFoundError
              ? Effect.void
              : Effect.gen(function* () {
                  logError("PollScheduler", `Manual thread sync failed for PR ${prId}:`, err);
                  yield* realtime.toPr(prId, {
                    type: "threads:sync-error",
                    data: { prId, message: err.message },
                  });
                }),
          ),
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              logError(
                "PollScheduler",
                `Manual thread sync failed for PR ${prId}:`,
                Cause.pretty(cause),
              );
              yield* realtime.toPr(prId, {
                type: "threads:sync-error",
                data: { prId, message: "Thread sync failed unexpectedly" },
              });
            }),
          ),
        ),
    };
  }),
);
