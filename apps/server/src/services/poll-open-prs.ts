/**
 * The open-PR list phases of `PollScheduler.syncAllRepos`: deciding which repos
 * need a re-list, listing and writing one repo, and settling the PRs that left
 * the open list.
 */
import type { PullRequest, Repository } from "@revv/shared";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { pullRequests } from "../db/schema/pull-requests";
import { DbError } from "../domain/errors";
import { withDb } from "../effects/with-db";
import { logError } from "../logger";
import { type OpenPrListSignature, sameSignature, signatureOfList } from "./github-graphql-prs";
import { apiBaseForHost } from "./github-rest";
import {
  broadcastToAccount,
  type GitHubInfra,
  type LiveAccount,
  type PollDeps,
  type SyncCycle,
} from "./poll-cycle";
import { needsDiffStats } from "./pr-diff-stats";
import { preserveHeadOnStaleRead } from "./pr-head-move";
import type { SettingsService } from "./Settings";

/**
 * Per-cycle cap on how many just-closed PRs we individually re-fetch to learn
 * whether they were merged or plain-closed. Applied per item, not to the batch:
 * exceeding it degrades the tail of the list to `'closed'`, it does not
 * abandon status resolution for the whole batch.
 */
const CLOSED_PR_STATUS_FETCH_LIMIT = 10;

/**
 * How long a repo can go without a real re-list on the strength of an
 * unchanged signature. Bounds what the signature can't see — a field GitHub
 * changes without bumping the PR's `updatedAt` (a base branch advancing), two
 * updates inside one second — and retries diff stats that failed.
 */
const FULL_LIST_MAX_AGE_MS = 30 * 60 * 1000;

/**
 * PRs whose diff range (head or base) moved since the pre-sync snapshot — the
 * ones whose cached diff is now wrong. A PR new to the mirror has none.
 */
export function movedRangePrIds(
  prs: readonly PullRequest[],
  existingMap: ReadonlyMap<string, PullRequest>,
): string[] {
  return prs
    .filter((pr) => {
      const existing = existingMap.get(pr.id);
      return (
        existing !== undefined &&
        (existing.headSha !== pr.headSha || existing.baseSha !== pr.baseSha)
      );
    })
    .map((pr) => pr.id);
}

/**
 * Whether the open list a client holds is out of date: a PR it has never
 * seen, or one whose list-visible fields moved. `updatedAt` is the cheap
 * catch-all — GitHub bumps it for pushes, edits, label and reviewer changes —
 * with the fields the UI keys on checked explicitly alongside it.
 */
export function openListMoved(
  prs: readonly PullRequest[],
  existingMap: ReadonlyMap<string, PullRequest>,
): boolean {
  return prs.some((pr) => {
    const existing = existingMap.get(pr.id);
    if (!existing) return true; // PR we had never seen
    return (
      existing.updatedAt !== pr.updatedAt ||
      existing.headSha !== pr.headSha ||
      existing.baseSha !== pr.baseSha ||
      existing.title !== pr.title ||
      existing.isDraft !== pr.isDraft
    );
  });
}

/** The last list of a repo that landed in SQLite, as its signature. */
export interface ListedSignature {
  readonly signature: OpenPrListSignature;
  readonly listedAt: number;
}

/**
 * Repos whose open-PR list can't have changed since it was last written, so
 * this cycle can reuse the DB rows instead of re-listing them.
 *
 * One aliased GraphQL probe per account and host — 1 point per 80 repos —
 * against one list query per repo (1 point per 100 PRs each). Only repos with
 * a recent recorded list qualify; a failed or skipped probe qualifies none,
 * which is exactly the old every-repo behaviour.
 */
export const findUnchangedRepos = (
  deps: PollDeps,
  cycle: SyncCycle,
  repos: readonly Repository[],
  listedSignatures: ReadonlyMap<string, ListedSignature>,
): Effect.Effect<Set<string>, never, SettingsService> =>
  Effect.gen(function* () {
    const now = Date.now();
    const candidatesByGroup = new Map<string, Repository[]>();
    for (const repo of repos) {
      const listed = listedSignatures.get(repo.id);
      if (!listed || now - listed.listedAt >= FULL_LIST_MAX_AGE_MS) continue;
      const accountId = cycle.repoToAccountId.get(repo.id);
      if (!accountId) continue;
      const key = `${accountId}\u0000${repo.githubHost}`;
      const group = candidatesByGroup.get(key);
      if (group) group.push(repo);
      else candidatesByGroup.set(key, [repo]);
    }

    const unchanged = new Set<string>();
    yield* Effect.forEach(
      candidatesByGroup.values(),
      (group) =>
        Effect.gen(function* () {
          const [first] = group;
          if (!first) return;
          // No GraphQL budget means no probe — and no GraphQL list either, so
          // the REST fallback's conditional requests decide instead.
          const live = cycle.liveAccountForRepo(first.id, "graphql");
          if (!live) return;
          const probed = yield* cycle.tryGuarded(
            live.acc,
            deps.github.prs.probeOpenLists(
              group.map((r) => r.fullName),
              live.token,
              apiBaseForHost(first.githubHost),
            ),
            { errorLabel: `open-PR list probe error for ${first.githubHost}` },
          );
          if (!probed) return;
          for (const repo of group) {
            const fresh = probed.get(repo.fullName);
            const listed = listedSignatures.get(repo.id);
            if (fresh && listed && sameSignature(fresh, listed.signature)) unchanged.add(repo.id);
          }
        }),
      { concurrency: 3, discard: true },
    );
    return unchanged;
  });

/**
 * One repo's open PRs over GraphQL, or over the REST list when the account's
 * GraphQL budget is spent — before the call or by it.
 */
const listOpenPrs = (
  deps: PollDeps,
  cycle: SyncCycle,
  repo: Repository,
  live: LiveAccount,
): Effect.Effect<PullRequest[] | null, never, GitHubInfra> =>
  Effect.gen(function* () {
    const apiBase = apiBaseForHost(repo.githubHost);
    if (cycle.liveAccount(live.acc, "graphql")) {
      const prs = yield* cycle.tryGuarded(
        live.acc,
        deps.github.prs.listOpen(repo.fullName, repo.id, live.token, apiBase),
        { errorLabel: `listPrs error for ${repo.fullName}` },
      );
      // Anything but a spent GraphQL budget is this repo's answer for the cycle.
      if (prs !== null || cycle.liveAccount(live.acc, "graphql")) return prs;
    }
    if (!cycle.liveAccount(live.acc, "core")) return null;
    return yield* cycle.tryGuarded(
      live.acc,
      deps.github.prs.listOpenRest(repo.fullName, repo.id, live.token, apiBase),
      { errorLabel: `listPrs (REST) error for ${repo.fullName}` },
    );
  });

export interface RepoListing {
  /** The repo's open PRs as they now stand in SQLite. */
  readonly prs: PullRequest[];
  /**
   * Whether GitHub was actually asked. Only a listed repo can prove a PR left
   * the open list; an unchanged repo's rows are the DB's own.
   */
  readonly listed: boolean;
}

export interface RepoListingContext {
  /** Pre-sync open rows by id: the baseline every "did this move?" reads. */
  readonly existingMap: ReadonlyMap<string, PullRequest>;
  readonly existingByRepo: ReadonlyMap<string, readonly PullRequest[]>;
  /** `pull_requests.diff_stats_head_sha` by PR id, advanced as stats land. */
  readonly diffStatsHeadByPrId: Map<string, string | null>;
  readonly unchangedRepoIds: ReadonlySet<string>;
  /** Written here whenever a full list lands in SQLite. */
  readonly listedSignatures: Map<string, ListedSignature>;
}

/**
 * Bring one repo's open PRs in SQLite up to date with GitHub. Null when the
 * repo couldn't be listed this cycle — its rows are then left untouched.
 */
export const syncRepoOpenPrs = (
  deps: PollDeps,
  cycle: SyncCycle,
  ctx: RepoListingContext,
  repo: Repository,
): Effect.Effect<RepoListing | null, never, GitHubInfra> =>
  Effect.gen(function* () {
    const { db, github, prService, remoteUserService, diffCache } = deps;
    const live = cycle.liveAccountForRepo(repo.id);
    if (!live) {
      // Surface the rare data-consistency case ("repo row with no account
      // row") — token-bad accounts already announced once upstream and stay
      // silent here.
      if (!cycle.repoToAccountId.get(repo.id)) {
        logError(
          "PollScheduler",
          `GitHub auth unavailable; skipping PR sync for ${repo.fullName} (no account row)`,
        );
      }
      return null;
    }

    if (ctx.unchangedRepoIds.has(repo.id)) {
      return { prs: [...(ctx.existingByRepo.get(repo.id) ?? [])], listed: false };
    }

    const prs = yield* listOpenPrs(deps, cycle, repo, live);
    // listPrs failed — leave existing DB rows untouched for this repo
    if (prs === null) return null;

    // Upsert PR authors into remote_users so their avatars are cached. Deduped
    // by login: a prolific author appears on many of a repo's open PRs, and
    // each upsert is a SELECT + UPSERT on the poll's critical path.
    const authorsByLogin = new Map<string, string | null>();
    for (const pr of prs) {
      if (!authorsByLogin.has(pr.authorLogin)) {
        authorsByLogin.set(pr.authorLogin, pr.authorAvatarUrl);
      }
    }
    for (const [login, avatarUrl] of authorsByLogin) {
      yield* remoteUserService.upsert({
        provider: "github",
        providerUserId: "", // Numeric ID not available from listPrs
        login,
        avatarUrl,
      });
    }

    // The list carries no diff size (hence 0/0/0); one aliased GraphQL request
    // fills it in — see `listPrDiffStats` for why not one detail fetch per PR.
    // Only requested for PRs never sized or whose head just moved, so steady
    // state adds no extra request.
    //
    // Mask before sizing/writing: sizing a stale head would persist stats over
    // a newer stored row, and the supersede gate reads the stored row, so a
    // regressed `updated_at` would pass on the next cycle. See
    // `preserveHeadOnStaleRead`.
    const maskedPrs = prs.map((pr) => preserveHeadOnStaleRead(ctx.existingMap.get(pr.id), pr));
    const needsStats = maskedPrs.filter((pr) =>
      needsDiffStats(ctx.existingMap.get(pr.id), ctx.diffStatsHeadByPrId.get(pr.id), pr.headSha),
    );

    // Best-effort, and skipped outright while the GraphQL budget is spent: on
    // failure rows keep their zeros and `upsertPrs`' `changed_files > 0` guard
    // leaves the DB's existing values intact.
    const statsLive = needsStats.length === 0 ? null : cycle.liveAccount(live.acc, "graphql");
    const diffStats =
      statsLive === null
        ? null
        : yield* cycle.tryGuarded(
            live.acc,
            github.prs.diffStats(
              repo.fullName,
              needsStats.map((pr) => pr.externalId),
              statsLive.token,
              apiBaseForHost(repo.githubHost),
            ),
            { errorLabel: `diffStats error for ${repo.fullName}` },
          );

    const rows = maskedPrs.map((pr) => {
      const stats = diffStats?.get(pr.externalId);
      return stats === undefined ? pr : { ...pr, ...stats };
    });

    // Drop the cached diff of every PR whose range moved *before* the new
    // head lands: from the moment the row says "new head", nothing may serve
    // it the old head's files. A read in between misses the cache and fetches
    // GitHub's current files, which already belong to the new head. The
    // re-fetch of the dropped diffs happens later in the cycle.
    const movedIds = movedRangePrIds(rows, ctx.existingMap);
    if (movedIds.length > 0) {
      const invalidated = yield* withDb(db, diffCache.invalidateFilesForPrs(movedIds)).pipe(
        Effect.as(true),
        Effect.catchAllCause((cause) =>
          Effect.sync(() => {
            logError("PollScheduler", `diff invalidation failed for ${repo.fullName}:`, cause);
            return false;
          }),
        ),
      );
      // Writing the new heads now would pair them with the old diffs. Leave
      // the repo's rows alone; the next cycle tries again.
      if (!invalidated) return null;
    }

    const upserted = yield* withDb(db, prService.upsertPrs(rows)).pipe(
      Effect.as(true),
      Effect.tapError((err) =>
        Effect.sync(() => {
          logError("PollScheduler", `upsertPrs error for ${repo.fullName}:`, err);
        }),
      ),
      Effect.orElseSucceed(() => false),
    );

    if (upserted && diffStats !== null) {
      yield* Effect.try({
        try: () =>
          db.transaction(() => {
            for (const pr of needsStats) {
              const stats = diffStats.get(pr.externalId);
              if (stats === undefined) continue;
              db.update(pullRequests)
                .set({
                  additions: stats.additions,
                  deletions: stats.deletions,
                  changedFiles: stats.changedFiles,
                  diffStatsHeadSha: pr.headSha,
                })
                .where(eq(pullRequests.id, pr.id))
                .run();
              ctx.diffStatsHeadByPrId.set(pr.id, pr.headSha);
            }
          }),
        catch: (cause) =>
          new DbError({ message: "Failed to persist PR diff-stat watermarks", cause }),
      }).pipe(
        Effect.tapError((error) =>
          Effect.sync(() => {
            logError("PollScheduler", "diff-stat watermark write failed:", error);
          }),
        ),
        Effect.orElseSucceed(() => undefined),
      );
    }

    // Only a list that fully landed may stand in for the next ones: rows
    // still missing their diff stats must come back round to get them.
    const statsComplete = needsStats.every((pr) => diffStats?.has(pr.externalId) === true);
    if (upserted && statsComplete) {
      ctx.listedSignatures.set(repo.id, { signature: signatureOfList(prs), listedAt: Date.now() });
    } else {
      ctx.listedSignatures.delete(repo.id);
    }

    // The masked rows, not the raw payload: everything downstream (the
    // supersede gate, the change detection, the broadcast) must see the same
    // view that landed in SQLite.
    return { prs: rows, listed: true };
  }).pipe(
    Effect.tapError((err) =>
      Effect.sync(() => {
        logError("PollScheduler", `outer per-repo sync error for ${repo.fullName}:`, err);
      }),
    ),
    Effect.orElseSucceed(() => null),
  );

/**
 * Settle PRs that were open before but are gone from GitHub's open list:
 * learn whether each merged or closed, archive it, reap its review worktree,
 * and tell its account's clients.
 */
export const archiveClosedPrs = (
  deps: PollDeps,
  cycle: SyncCycle,
  closedPrs: readonly PullRequest[],
  repoById: ReadonlyMap<string, Repository>,
): Effect.Effect<void, never, GitHubInfra> =>
  Effect.gen(function* () {
    const { db, github, prService, repoClone } = deps;
    const updates: Array<{ id: string; status: "closed" | "merged"; closedAt: string }> =
      yield* Effect.forEach(
        closedPrs,
        (pr, index) =>
          Effect.gen(function* () {
            // `'closed'` is the degraded answer: it records that the PR left
            // the open list without claiming to know whether it merged.
            // Nothing ever revisits it — the archive backfill only fetches PRs
            // missing from the mirror — so a wrong answer here is permanent,
            // and shows up later as a merged PR labelled "closed" with +0/-0
            // stats in recaps.
            const degraded = {
              id: pr.id,
              status: "closed" as const,
              closedAt: new Date().toISOString(),
            };

            // Bound the GitHub cost per cycle. Applied to this item's
            // position, so a burst of closures degrades only its tail; testing
            // the batch size instead would degrade *every* PR the moment the
            // batch crossed the limit.
            if (index >= CLOSED_PR_STATUS_FETCH_LIMIT) return degraded;

            const repo = repoById.get(pr.repositoryId);
            const live = repo ? cycle.liveAccountForRepo(repo.id, "core") : null;
            if (!repo || !live) return degraded;

            const fetched = yield* cycle.tryGuarded(
              live.acc,
              github.prs.get(
                repo.fullName,
                pr.externalId,
                live.token,
                apiBaseForHost(repo.githubHost),
              ),
            );
            if (!fetched) return degraded;
            const resolvedStatus = fetched.status === "merged" ? "merged" : "closed";
            const closedAt = fetched.closedAt ?? new Date().toISOString();
            return { id: pr.id, status: resolvedStatus as "closed" | "merged", closedAt };
          }),
        { concurrency: 5 },
      );

    yield* withDb(db, prService.markPrsClosed(updates)).pipe(Effect.orElseSucceed(() => undefined));

    // Reap the review worktree + `revv/pr-N` branch for each PR that just went
    // terminal, so they stop accumulating in the user's clone (and cluttering
    // VSCode). `pruneWorktree` self-guards against in-flight generations and
    // un-pushed review commits, so this is safe to fire-and-forget; it must not
    // block the sync loop.
    yield* Effect.forkDaemon(
      Effect.forEach(
        closedPrs,
        (pr) =>
          repoClone
            .pruneWorktree({ repoId: pr.repositoryId, prNumber: pr.externalId })
            .pipe(Effect.catchAll(() => Effect.void)),
        { concurrency: 3, discard: true },
      ),
    );

    // Targeted `pr:archived` envelopes for each transition. The full PR set
    // still goes out via the cycle's `prs:updated` broadcast; this gives
    // clients a low-latency signal they can patch in place without refetching
    // the archive list. Best-effort — if a single emit fails, the bulk update
    // still reconciles on the next `prs:updated` arrival.
    const closedPrMap = new Map(closedPrs.map((pr) => [pr.id, pr]));
    for (const upd of updates) {
      const pr = closedPrMap.get(upd.id);
      if (!pr) continue;
      const accountId = cycle.repoToAccountId.get(pr.repositoryId);
      if (!accountId) continue;
      yield* broadcastToAccount(deps, accountId, {
        type: "pr:archived",
        data: {
          prId: upd.id,
          repoId: pr.repositoryId,
          status: upd.status,
          closedAt: upd.closedAt,
        },
      });
    }
  });
