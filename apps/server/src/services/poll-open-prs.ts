/**
 * The open-PR list phases of `PollScheduler.syncAllRepos`: deciding which repos
 * need a re-list, listing and writing one repo, and settling the PRs that left
 * the open list.
 */
import { type PullRequest, type Repository, sameStack } from "@revv/shared";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { pullRequests } from "../db/schema/pull-requests";
import { DbError } from "../domain/errors";
import { withDb } from "../effects/with-db";
import { logError } from "../logger";
import {
  OPEN_PRS_LIST_CAP,
  OPEN_PRS_PAGE_SIZE,
  type OpenPrList,
  type OpenPrListSignature,
  sameSignature,
  signatureOfList,
} from "./github-graphql-prs";
import { apiBaseForHost } from "./github-rest";
import {
  announceStacks,
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
 * How long a repo can go without a full re-list, on the strength of unchanged
 * signatures and reads of just what moved. Bounds what neither can see — a
 * field GitHub changes without bumping the PR's `updatedAt` (a base branch
 * advancing), two updates inside one second — and retries diff stats that
 * failed. A big repo's full list is dozens of pages for that safety net
 * alone, so it waits longer.
 */
const FULL_LIST_MAX_AGE_MS = 30 * 60 * 1000;
const LARGE_REPO_FULL_LIST_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const LARGE_REPO_OPEN_PRS = 500;

/**
 * A stacked repo up to this size is fully re-listed every cycle: the signature
 * only sees a stack change through the PR's `updatedAt`, and nothing promises
 * GitHub bumps it for one. Past it, that costs too many pages per cycle, and
 * the repo is read by what moved like any other.
 */
const STACKED_FULL_LIST_MAX_PRS = 300;

/**
 * What a read of just what moved costs at least: the open PRs updated since,
 * and the PRs closed since, one request each.
 */
const DELTA_MIN_REQUESTS = 2;

function fullListMaxAge(listed: ListedSignature): number {
  return listed.signature.count > LARGE_REPO_OPEN_PRS
    ? LARGE_REPO_FULL_LIST_MAX_AGE_MS
    : FULL_LIST_MAX_AGE_MS;
}

/**
 * Whether a probe could spare `listed`'s repo a full list. A stacked repo up
 * to {@link STACKED_FULL_LIST_MAX_PRS} never: nothing a probe sees covers its
 * stacks. Neither does a list past {@link fullListMaxAge}.
 */
function worthProbing(listed: ListedSignature, now: number): boolean {
  if (listed.hasStacks && listed.signature.count <= STACKED_FULL_LIST_MAX_PRS) return false;
  return now - listed.fullListedAt < fullListMaxAge(listed);
}

/**
 * How a repo's open list is brought up to date this cycle:
 *
 * - `reuse`: the probe proves nothing moved, so the DB rows stand. Never for
 *   a manual sync (`reuse: false`), nor a repo holding a stack, whose stack
 *   can move without the signature seeing it.
 * - `delta`: read only what moved since the last list, checked against the
 *   probe's count. Only where it is cheaper than the full list, which a repo
 *   whose open PRs fit in {@link DELTA_MIN_REQUESTS} pages isn't.
 * - `full`: list everything.
 *
 * `probed` is undefined for a repo that wasn't probed, or the probe couldn't
 * answer for.
 */
export function decideListing(
  listed: ListedSignature | undefined,
  probed: OpenPrListSignature | undefined,
  now: number,
  reuse: boolean,
): "reuse" | "delta" | "full" {
  if (!listed || !probed || !worthProbing(listed, now)) return "full";
  if (reuse && !listed.hasStacks && listUnchanged(listed, probed)) return "reuse";
  return Math.ceil(probed.count / OPEN_PRS_PAGE_SIZE) > DELTA_MIN_REQUESTS ? "delta" : "full";
}

/**
 * How long a host that refused the stack fields is listed without them before
 * asking again: a GitHub Enterprise upgrade gets stacks back without a restart.
 */
const STACKLESS_RECHECK_MS = FULL_LIST_MAX_AGE_MS;

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
      existing.isDraft !== pr.isDraft ||
      !sameStack(existing.stack, pr.stack)
    );
  });
}

/** The last list of a repo that landed in SQLite, as its signature. */
export interface ListedSignature {
  readonly signature: OpenPrListSignature;
  readonly listedAt: number;
  /** When the last *full* list landed; a read of what moved doesn't reset it. */
  readonly fullListedAt: number;
  /** Whether any of its PRs sat in a stack (see `STACKED_FULL_LIST_MAX_PRS`). */
  readonly hasStacks: boolean;
  /**
   * The repo has more open PRs than a list holds (`OPEN_PRS_LIST_CAP`), so the
   * stored list is only its most recently updated ones and its count can't
   * be checked against GitHub's: only the newest `updatedAt` can.
   */
  readonly truncated: boolean;
}

/** Whether a probe proves the list `listed` describes hasn't moved. */
function listUnchanged(listed: ListedSignature, fresh: OpenPrListSignature): boolean {
  return listed.truncated
    ? fresh.latestUpdatedAt === listed.signature.latestUpdatedAt
    : sameSignature(fresh, listed.signature);
}

/** Key of the per-account, per-host state the poll keeps between cycles. */
const accountHostKey = (accountId: string, githubHost: string) => `${accountId}\u0000${githubHost}`;

export interface ProbedRepos {
  /** Repos whose open-PR list can't have changed: reuse the DB rows. */
  readonly unchanged: Set<string>;
  /**
   * Repos to read by what moved, by repo id, with the probed signature that
   * read checks itself against.
   */
  readonly signatures: Map<string, OpenPrListSignature>;
}

/**
 * Probe the repos a probe could spare a full list, and sort them by
 * {@link decideListing}: the ones to reuse, and the ones to read by what
 * moved. Every other repo is listed in full.
 *
 * One aliased GraphQL probe per account and host — 1 point per 80 repos.
 * A failed or skipped probe sorts none, which is exactly a full list for
 * every repo.
 */
export const probeRepos = (
  deps: PollDeps,
  cycle: SyncCycle,
  repos: readonly Repository[],
  listedSignatures: ReadonlyMap<string, ListedSignature>,
  reuse: boolean,
): Effect.Effect<ProbedRepos, never, SettingsService> =>
  Effect.gen(function* () {
    const now = Date.now();
    const candidatesByGroup = new Map<string, Repository[]>();
    for (const repo of repos) {
      const listed = listedSignatures.get(repo.id);
      if (!listed || !worthProbing(listed, now)) continue;
      const accountId = cycle.repoToAccountId.get(repo.id);
      if (!accountId) continue;
      const key = accountHostKey(accountId, repo.githubHost);
      const group = candidatesByGroup.get(key);
      if (group) group.push(repo);
      else candidatesByGroup.set(key, [repo]);
    }

    const unchanged = new Set<string>();
    const signatures = new Map<string, OpenPrListSignature>();
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
            const plan = decideListing(listedSignatures.get(repo.id), fresh, now, reuse);
            if (plan === "reuse") unchanged.add(repo.id);
            else if (plan === "delta" && fresh) signatures.set(repo.id, fresh);
          }
        }),
      { concurrency: 3, discard: true },
    );
    return { unchanged, signatures };
  });

/**
 * One repo's open PRs over GraphQL, or over the REST list when the account's
 * GraphQL budget is spent — before the call or by it.
 */
const listOpenPrs = (
  deps: PollDeps,
  cycle: SyncCycle,
  ctx: RepoListingContext,
  repo: Repository,
  live: LiveAccount,
): Effect.Effect<OpenPrList | null, never, GitHubInfra> =>
  Effect.gen(function* () {
    const apiBase = apiBaseForHost(repo.githubHost);
    if (cycle.liveAccount(live.acc, "graphql")) {
      const listing = yield* listOpenPrsGraphql(deps, cycle, ctx, repo, live, null);
      // Anything but a spent GraphQL budget is this repo's answer for the cycle.
      if (listing !== null || cycle.liveAccount(live.acc, "graphql")) return listing;
    }
    if (!cycle.liveAccount(live.acc, "core")) return null;
    const prs = yield* cycle.tryGuarded(
      live.acc,
      deps.github.prs.listOpenRest(repo.fullName, repo.id, live.token, apiBase),
      { errorLabel: `listPrs (REST) error for ${repo.fullName}` },
    );
    // REST has no stacks.
    return prs === null ? null : { prs, stacks: "unknown" };
  });

/**
 * The GraphQL open list, all of it or (with `updatedSince`) what moved since.
 * Stacks are asked for unless this account's host refused them recently. The
 * refusal is remembered per account, not per host: GitHub may gate the fields
 * per token, and one account's answer mustn't switch them off for the rest.
 */
const listOpenPrsGraphql = (
  deps: PollDeps,
  cycle: SyncCycle,
  ctx: RepoListingContext,
  repo: Repository,
  live: LiveAccount,
  updatedSince: string | null,
): Effect.Effect<OpenPrList | null, never, GitHubInfra> =>
  Effect.gen(function* () {
    const stacklessKey = accountHostKey(live.acc.id, repo.githubHost);
    const stacklessUntil = ctx.stacklessUntil.get(stacklessKey);
    const listing = yield* cycle.tryGuarded(
      live.acc,
      deps.github.prs.listOpen(
        repo.fullName,
        repo.id,
        live.token,
        apiBaseForHost(repo.githubHost),
        {
          withStacks: stacklessUntil === undefined || Date.now() >= stacklessUntil,
          updatedSince,
        },
      ),
      { errorLabel: `listPrs error for ${repo.fullName}` },
    );
    if (listing?.stacks === "unsupported") {
      ctx.stacklessUntil.set(stacklessKey, Date.now() + STACKLESS_RECHECK_MS);
    } else if (listing?.stacks === "listed") {
      ctx.stacklessUntil.delete(stacklessKey);
    }
    return listing;
  });

/** A repo's open list rebuilt from what moved, on top of the rows already stored. */
interface DeltaListing extends OpenPrList {
  /** Stored rows nothing touched: still open, not updated since. */
  readonly kept: readonly PullRequest[];
}

/**
 * Bring a repo's list up to date by reading only what moved since the last
 * one: the open PRs updated since its newest `updatedAt`, and the PRs closed
 * since. Null whenever that wasn't the plan (no probed signature: see
 * {@link decideListing}) or can't be trusted — a result whose size disagrees
 * with the probe — and the caller lists the repo in full instead.
 */
const listOpenPrsDelta = (
  deps: PollDeps,
  cycle: SyncCycle,
  ctx: RepoListingContext,
  repo: Repository,
  live: LiveAccount,
): Effect.Effect<DeltaListing | null, never, GitHubInfra> =>
  Effect.gen(function* () {
    const listed = ctx.listedSignatures.get(repo.id);
    const probed = ctx.probedSignatures.get(repo.id);
    const since = listed?.signature.latestUpdatedAt ?? null;
    if (!listed || !probed || since === null) return null;
    if (!cycle.liveAccount(live.acc, "graphql")) return null;

    const [open, closed] = yield* Effect.all(
      [
        listOpenPrsGraphql(deps, cycle, ctx, repo, live, since),
        cycle.tryGuarded(
          live.acc,
          deps.github.prs.listClosedSince(
            repo.fullName,
            since,
            live.token,
            apiBaseForHost(repo.githubHost),
          ),
          { errorLabel: `closed-PR read error for ${repo.fullName}` },
        ),
      ],
      { concurrency: 2 },
    );
    if (open === null || closed === null) return null;

    const closedNumbers = new Set(closed);
    const movedIds = new Set(open.prs.map((pr) => pr.id));
    const kept = (ctx.existingByRepo.get(repo.id) ?? []).filter(
      (pr) => !movedIds.has(pr.id) && !closedNumbers.has(pr.externalId),
    );
    // The probe counted GitHub's open list a moment ago. Anything else means
    // a PR left or arrived without an update this read could see (deleted,
    // transferred, or moved between the probe and now): list it all. A list
    // cut at the cap can't be counted, and leans on the full-list safety net.
    if (!listed.truncated && kept.length + open.prs.length !== probed.count) return null;
    return { ...open, kept };
  });

/**
 * Stacks whose detail moved since the pre-sync snapshot: a member joined,
 * left, changed place, or its head or base moved. Both the old and the new
 * stack of a PR that switched count.
 */
export function movedStackNumbers(
  prs: readonly PullRequest[],
  existingMap: ReadonlyMap<string, PullRequest>,
): Set<number> {
  const moved = new Set<number>();
  for (const pr of prs) {
    const existing = existingMap.get(pr.id);
    const placeMoved = !sameStack(existing?.stack ?? null, pr.stack);
    const rangeMoved =
      existing !== undefined &&
      (existing.headSha !== pr.headSha || existing.baseSha !== pr.baseSha);
    if (!placeMoved && !rangeMoved) continue;
    if (pr.stack) moved.add(pr.stack.number);
    if (placeMoved && existing?.stack) moved.add(existing.stack.number);
  }
  return moved;
}

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
  /**
   * The repos this cycle reads by what moved, with the probed signature each
   * read checks against (`ProbedRepos.signatures`).
   */
  readonly probedSignatures: ReadonlyMap<string, OpenPrListSignature>;
  /** Written here whenever a full list lands in SQLite. */
  readonly listedSignatures: Map<string, ListedSignature>;
  /**
   * Until when each account and host is listed without stacks, after its host
   * refused the fields. A reconstructible cache: a restart asks again.
   */
  readonly stacklessUntil: Map<string, number>;
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

    const delta = yield* listOpenPrsDelta(deps, cycle, ctx, repo, live);
    const listing = delta ?? (yield* listOpenPrs(deps, cycle, ctx, repo, live));
    // listPrs failed — leave existing DB rows untouched for this repo
    if (listing === null) return null;
    // From here on, `prs` is what GitHub sent: everything, or just what moved.
    const { prs } = listing;
    const kept = delta?.kept ?? [];
    const stacksKnown = listing.stacks === "listed";

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
    // fills it in — see `listPrDiffStatsViaGraphql` for why not one detail fetch per PR.
    // Only requested for PRs never sized or whose head just moved, so steady
    // state adds no extra request.
    //
    // Mask before sizing/writing: sizing a stale head would persist stats over
    // a newer stored row, and the supersede gate reads the stored row, so a
    // regressed `updated_at` would pass on the next cycle. See
    // `preserveHeadOnStaleRead`.
    //
    // A list that couldn't see stacks keeps the stored ones: its nulls mean
    // "unknown", and passing them downstream would announce every stack
    // dissolved until the next list that sees them.
    const maskedPrs = prs.map((pr) => {
      const existing = ctx.existingMap.get(pr.id);
      const masked = preserveHeadOnStaleRead(existing, pr);
      return stacksKnown ? masked : { ...masked, stack: existing?.stack ?? null };
    });
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
        Effect.catchCause((cause) =>
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

    const upserted = yield* withDb(db, prService.upsertPrs(rows, { stacksKnown })).pipe(
      Effect.as(true),
      Effect.tapError((err) =>
        Effect.sync(() => {
          logError("PollScheduler", `upsertPrs error for ${repo.fullName}:`, err);
        }),
      ),
      Effect.orElseSucceed(() => false),
    );

    if (upserted) {
      const accountId = cycle.repoToAccountId.get(repo.id);
      const stacks = movedStackNumbers(rows, ctx.existingMap);
      if (accountId && stacks.size > 0) yield* announceStacks(deps, accountId, repo.id, stacks);
    }

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

    // The repo's whole open list as it now stands in SQLite: the masked rows,
    // not the raw payload, since everything downstream (the supersede gate,
    // the change detection, the broadcast) must see the view that landed.
    const current = [...rows, ...kept];

    // Only a list that fully landed may stand in for the next ones: rows
    // still missing their diff stats must come back round to get them.
    const statsComplete = needsStats.every((pr) => diffStats?.has(pr.externalId) === true);
    if (upserted && statsComplete) {
      const now = Date.now();
      const previous = ctx.listedSignatures.get(repo.id);
      ctx.listedSignatures.set(repo.id, {
        signature: signatureOfList(current),
        listedAt: now,
        fullListedAt: delta ? (previous?.fullListedAt ?? now) : now,
        hasStacks: current.some((pr) => pr.stack !== null),
        truncated: delta ? (previous?.truncated ?? false) : prs.length >= OPEN_PRS_LIST_CAP,
      });
    } else {
      ctx.listedSignatures.delete(repo.id);
    }

    yield* Effect.annotateCurrentSpan("prs_open", current.length);
    return { prs: current, listed: true };
  }).pipe(
    Effect.withSpan("PollScheduler.syncRepo", {
      attributes: { repo: repo.fullName, repoId: repo.id },
    }),
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
    yield* Effect.forkDetach(
      Effect.forEach(
        closedPrs,
        (pr) =>
          repoClone
            .pruneWorktree({ repoId: pr.repositoryId, prNumber: pr.externalId })
            .pipe(Effect.catch(() => Effect.void)),
        { concurrency: 3, discard: true },
      ),
    );

    // A stacked PR that merged or closed changes what its stack shows.
    const stacksByRepo = Map.groupBy(
      closedPrs.flatMap((pr) => (pr.stack ? [{ repoId: pr.repositoryId, stack: pr.stack }] : [])),
      (entry) => entry.repoId,
    );
    for (const [repoId, entries] of stacksByRepo) {
      const accountId = cycle.repoToAccountId.get(repoId);
      if (accountId) {
        yield* announceStacks(
          deps,
          accountId,
          repoId,
          entries.map((entry) => entry.stack.number),
        );
      }
    }

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
