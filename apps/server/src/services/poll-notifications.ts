import { loginsMatch, type PullRequest, type Repository, type SyncChange } from "@revv/shared";
import type { Context } from "effect";
import { Cause, Effect } from "effect";
import type { Db } from "../db/index";
import { withDb } from "../effects/with-db";
import { logError } from "../logger";
import type { Realtime } from "./Realtime";
import type { WalkthroughService } from "./walkthrough/Walkthrough";
import type { WalkthroughJobs } from "./walkthrough/WalkthroughJobs";

export interface CycleOutcome {
  readonly allRepos: readonly Repository[];
  /** This cycle's open PRs, as they now stand in SQLite. */
  readonly allPrs: readonly PullRequest[];
  /** Pre-sync open rows by id. */
  readonly existingMap: ReadonlyMap<string, PullRequest>;
  /** PRs that left the open list this cycle. */
  readonly closedPrIds: readonly string[];
}

/** Who each account is, for telling which PRs are "for me". */
export interface CycleViewers {
  readonly repoToAccountId: ReadonlyMap<string, string>;
  /** The viewer login of each account (`GitHubAccounts.viewerLogin`). */
  readonly viewerLoginByAccount: ReadonlyMap<string, string | null>;
}

/** The notification-worthy differences between the pre-sync rows and this cycle's. */
export function collectSyncChanges(viewers: CycleViewers, outcome: CycleOutcome): SyncChange[] {
  const { allRepos, allPrs, existingMap, closedPrIds } = outcome;
  const changes: SyncChange[] = [];
  const repoFullName = (repositoryId: string) =>
    allRepos.find((r) => r.id === repositoryId)?.fullName ?? repositoryId;

  for (const pr of allPrs) {
    // Per repo: each is owned by one account, whose viewer is "me".
    const accountId = viewers.repoToAccountId.get(pr.repositoryId);
    const userLogin = accountId ? (viewers.viewerLoginByAccount.get(accountId) ?? null) : null;
    const requested = (reviewers: readonly string[]) =>
      userLogin !== null && reviewers.some((login) => loginsMatch(login, userLogin));
    const existing = existingMap.get(pr.id);
    const base = {
      prId: pr.id,
      prTitle: pr.title,
      prNumber: pr.externalId,
      repoFullName: repoFullName(pr.repositoryId),
    };

    if (!existing) {
      if (requested(pr.requestedReviewers)) {
        changes.push({ kind: "review_requested", ...base });
      } else if (userLogin !== null && loginsMatch(pr.authorLogin, userLogin)) {
        changes.push({ kind: "pr_authored", ...base });
      }
    } else if (existing.headSha !== pr.headSha) {
      changes.push({ kind: "pr_updated", ...base });
    } else if (requested(pr.requestedReviewers) && !requested(existing.requestedReviewers)) {
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
  svc: {
    readonly db: Db;
    readonly realtime: Context.Service.Shape<typeof Realtime>;
    readonly walkthroughService: Context.Service.Shape<typeof WalkthroughService>;
    readonly walkthroughJobs: Context.Service.Shape<typeof WalkthroughJobs>;
  },
  viewers: CycleViewers,
  outcome: CycleOutcome,
  changes: readonly SyncChange[],
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const { allPrs, existingMap, closedPrIds } = outcome;
    // Closed PRs are no longer in `allPrs`: their account comes from the
    // pre-sync row.
    const changeAccountByPrId = new Map<string, string>();
    for (const pr of [...allPrs, ...closedPrIds.flatMap((id) => existingMap.get(id) ?? [])]) {
      const accountId = viewers.repoToAccountId.get(pr.repositoryId);
      if (accountId) changeAccountByPrId.set(pr.id, accountId);
    }

    const changesByAccount = Map.groupBy(
      changes.filter((c) => changeAccountByPrId.has(c.prId)),
      (c) => changeAccountByPrId.get(c.prId) ?? "",
    );
    for (const [accountId, accountChanges] of changesByAccount) {
      yield* svc.realtime.toAccount(accountId, {
        type: "prs:sync-summary",
        data: accountChanges,
      });
    }

    // Detached: the sync loop must not wait on AI work. `startJob` runs the
    // generation itself in a job fiber.
    for (const change of changes) {
      if (change.kind !== "review_requested") continue;
      const pr = allPrs.find((p) => p.id === change.prId);
      if (!pr || pr.headSha === null) continue;
      const uncached = yield* withDb(
        svc.db,
        svc.walkthroughService.getCached(pr.id, pr.headSha),
      ).pipe(
        Effect.map((cached) => cached === null),
        Effect.catchTag("DbError", (err) =>
          Effect.sync(() => {
            logError("PollScheduler", `auto-walkthrough skipped for PR ${pr.id}:`, err.message);
            return false;
          }),
        ),
      );
      if (!uncached) continue;
      yield* Effect.forkDetach(
        svc.walkthroughJobs
          .startJob({
            prId: pr.id,
            trigger: "review_requested",
            replace: "none",
          })
          .pipe(
            Effect.catchCause((cause) =>
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
