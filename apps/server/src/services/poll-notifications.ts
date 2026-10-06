/**
 * What a sync cycle tells the user: the per-account `prs:sync-summary`
 * notifications, and the walkthroughs auto-started for new review requests.
 */
import type { PullRequest, Repository, SyncChange } from "@revv/shared";
import { Cause, Effect } from "effect";
import { withDb } from "../effects/with-db";
import { logError } from "../logger";
import type { PollDeps, SyncCycle } from "./poll-cycle";

export interface CycleOutcome {
  readonly allRepos: readonly Repository[];
  /** This cycle's open PRs, as they now stand in SQLite. */
  readonly allPrs: readonly PullRequest[];
  /** Pre-sync open rows by id. */
  readonly existingMap: ReadonlyMap<string, PullRequest>;
  /** PRs that left the open list this cycle. */
  readonly closedPrIds: readonly string[];
}

/**
 * The notification-worthy differences between the pre-sync rows and this
 * cycle's. Reads each repo's account `githubLogin` from `cycle.accountById`, so
 * it must run after anything that refreshes account identities.
 */
export function collectSyncChanges(cycle: SyncCycle, outcome: CycleOutcome): SyncChange[] {
  const { allRepos, allPrs, existingMap, closedPrIds } = outcome;
  const changes: SyncChange[] = [];
  const repoFullName = (repositoryId: string) =>
    allRepos.find((r) => r.id === repositoryId)?.fullName ?? repositoryId;

  for (const pr of allPrs) {
    // The "is this PR for me" check is per-account: each repo is owned by
    // exactly one OAuth account, and `account.github_login` is that account's
    // GitHub identity. Using the first user's githubLogin (the previous
    // behavior) misattributes review requests as soon as multiple users or
    // multiple accounts on the same host exist.
    const accIdForLogin = cycle.repoToAccountId.get(pr.repositoryId);
    const userLogin = accIdForLogin
      ? (cycle.accountById.get(accIdForLogin)?.githubLogin ?? null)
      : null;
    const existing = existingMap.get(pr.id);
    const base = {
      prId: pr.id,
      prTitle: pr.title,
      prNumber: pr.externalId,
      repoFullName: repoFullName(pr.repositoryId),
    };

    if (!existing) {
      if (userLogin && pr.requestedReviewers.includes(userLogin)) {
        changes.push({ kind: "review_requested", ...base });
      } else if (userLogin && pr.authorLogin === userLogin) {
        changes.push({ kind: "pr_authored", ...base });
      }
    } else if (existing.headSha !== pr.headSha) {
      changes.push({ kind: "pr_updated", ...base });
    } else if (
      userLogin &&
      pr.requestedReviewers.includes(userLogin) &&
      !existing.requestedReviewers.includes(userLogin)
    ) {
      changes.push({ kind: "review_requested", ...base });
    }
  }

  for (const prId of closedPrIds) {
    const pr = existingMap.get(prId);
    if (pr) {
      changes.push({
        kind: "pr_closed",
        prId,
        prTitle: pr.title,
        prNumber: pr.externalId,
        repoFullName: repoFullName(pr.repositoryId),
      });
    }
  }
  return changes;
}

/**
 * Broadcast `changes` per account, and auto-start a walkthrough for each newly
 * requested review so it's ready (or already streaming) by the time the user
 * opens the PR.
 */
export const announceSyncChanges = (
  deps: PollDeps,
  cycle: SyncCycle,
  outcome: CycleOutcome,
  changes: readonly SyncChange[],
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const { allPrs, existingMap, closedPrIds } = outcome;
    // Group changes by account and broadcast per-account. Closed PRs are no
    // longer present in `allPrs`, so resolve their account from the pre-sync
    // row instead of dropping them into an `unknown` bucket.
    const changeAccountByPrId = new Map<string, string>();
    for (const pr of allPrs) {
      const accountId = cycle.repoToAccountId.get(pr.repositoryId);
      if (accountId) changeAccountByPrId.set(pr.id, accountId);
    }
    for (const prId of closedPrIds) {
      const pr = existingMap.get(prId);
      if (!pr) continue;
      const accountId = cycle.repoToAccountId.get(pr.repositoryId);
      if (accountId) changeAccountByPrId.set(prId, accountId);
    }

    const changesByAccount = Map.groupBy(
      changes,
      (c) => changeAccountByPrId.get(c.prId) ?? "unknown",
    );
    for (const [accountId, accountChanges] of changesByAccount) {
      yield* deps.broadcaster.broadcastToAccount(accountId, {
        type: "prs:sync-summary",
        data: accountChanges,
      });
    }

    // Fire-and-forget: the sync loop must not block on AI work, and
    // `startJob` already daemon-forks the actual generation fiber.
    for (const change of changes) {
      if (change.kind !== "review_requested") continue;
      const pr = allPrs.find((p) => p.id === change.prId);
      if (!pr || pr.headSha === null) continue;
      const cached = yield* withDb(deps.db, deps.walkthroughService.getCached(pr.id, pr.headSha));
      if (cached !== null) continue;
      yield* Effect.forkDaemon(
        deps.walkthroughJobs
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
  });
