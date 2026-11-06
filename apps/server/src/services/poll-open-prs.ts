import { type PullRequest, type Repository, sameStack } from "@revv/shared";
import type { Context } from "effect";
import { Effect } from "effect";
import { type ObservedPr, STACK_UNSEEN } from "../domain/observed-pr";
import { logError } from "../logger";
import type { AvatarCache } from "./github/avatars";
import type { GitHubGateway } from "./github/gateway";
import {
  OPEN_PRS_LIST_CAP,
  OPEN_PRS_PAGE_SIZE,
  type OpenPrList,
  type OpenPrListSignature,
  sameSignature,
  signatureOfList,
} from "./github/pulls";
import type { GitHubClient } from "./github/transport";
import type { PrMirror } from "./PrMirror";
import type { AccountGate } from "./poll-gate";
import type { ListedSignature, PollState } from "./poll-state";
import { needsDiffStats } from "./pr-diff-stats";
import { preserveHeadOnStaleRead } from "./pr-head-move";

type Github = Context.Service.Shape<typeof GitHubGateway>;

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

const STACKED_RELIST_EVERY_CYCLE_MAX_PRS = 300;

const DELTA_MIN_REQUESTS = 2;

function fullListMaxAge(listed: ListedSignature): number {
  return listed.signature.count > LARGE_REPO_OPEN_PRS
    ? LARGE_REPO_FULL_LIST_MAX_AGE_MS
    : FULL_LIST_MAX_AGE_MS;
}

/** What an unchanged probe signature (count + newest `updatedAt`) vouches for in a stored list. */
type SignatureCoverage =
  /** No stacks: an unchanged signature means nothing moved. */
  | "whole-list"
  /** Stacked, too big to re-list every cycle: a delta read is fine, reuse never is. */
  | "all-but-stacks"
  /** Stacked and small enough to re-list every cycle, or past `fullListMaxAge`. */
  | "none";

function signatureCoverage(listed: ListedSignature, now: number): SignatureCoverage {
  if (now - listed.fullListedAt >= fullListMaxAge(listed)) return "none";
  if (!listed.hasStacks) return "whole-list";
  return listed.signature.count <= STACKED_RELIST_EVERY_CYCLE_MAX_PRS ? "none" : "all-but-stacks";
}

function deltaCheaperThanFull(probed: OpenPrListSignature): boolean {
  return Math.ceil(probed.count / OPEN_PRS_PAGE_SIZE) > DELTA_MIN_REQUESTS;
}

export function decideListing(
  listed: ListedSignature | undefined,
  probed: OpenPrListSignature | undefined,
  now: number,
  reuse: boolean,
): "reuse" | "delta" | "full" {
  if (!listed || !probed) return "full";
  const coverage = signatureCoverage(listed, now);
  if (coverage === "none") return "full";
  if (reuse && coverage === "whole-list" && listUnchanged(listed, probed)) return "reuse";
  return deltaCheaperThanFull(probed) ? "delta" : "full";
}

/**
 * PRs whose diff range (head or base) moved since the pre-sync snapshot — the
 * ones whose cached diff is now wrong. A PR new to the mirror has none.
 */
export function movedRangePrIds(
  prs: readonly Pick<PullRequest, "id" | "headSha" | "baseSha">[],
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
    if (!existing) return true;
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

function listUnchanged(listed: ListedSignature, fresh: OpenPrListSignature): boolean {
  return listed.truncated
    ? fresh.latestUpdatedAt === listed.signature.latestUpdatedAt
    : sameSignature(fresh, listed.signature);
}

const accountHostKey = (accountId: string, githubHost: string) => `${accountId}\u0000${githubHost}`;

export interface ProbedRepos {
  readonly unchanged: Set<string>;
  readonly signatures: Map<string, OpenPrListSignature>;
}

/**
 * Probe the open-list signature of every repo with a recent list, one GraphQL
 * request per account and host, to find the repos that need no re-list.
 */
export const probeRepos = (
  github: Github,
  gate: AccountGate,
  state: PollState,
  repos: readonly Repository[],
  reuse: boolean,
): Effect.Effect<ProbedRepos> =>
  Effect.gen(function* () {
    const now = Date.now();
    const candidatesByGroup = new Map<string, Repository[]>();
    for (const repo of repos) {
      const listed = state.listed(repo.id);
      if (!listed || signatureCoverage(listed, now) === "none") continue;
      const accountId = gate.repoToAccountId.get(repo.id);
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
          const client = yield* gate.clientForRepo(first.id, "graphql");
          if (!client) return;
          const probed = yield* gate.guarded(
            github.prs.probeOpenLists(
              client,
              group.map((r) => r.fullName),
            ),
            `open-PR list probe error for ${first.githubHost}`,
          );
          if (!probed) return;
          for (const repo of group) {
            const fresh = probed.get(repo.fullName);
            const plan = decideListing(state.listed(repo.id), fresh, now, reuse);
            if (plan === "reuse") unchanged.add(repo.id);
            else if (plan === "delta" && fresh) signatures.set(repo.id, fresh);
          }
        }),
      { concurrency: 3, discard: true },
    );
    return { unchanged, signatures };
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
  /** `pull_requests.diff_stats_head_sha` by PR id. */
  readonly diffStatsHeadByPrId: ReadonlyMap<string, string | null>;
  readonly unchangedRepoIds: ReadonlySet<string>;
  readonly probedSignatures: ReadonlyMap<string, OpenPrListSignature>;
}

export interface ListingServices {
  readonly github: Github;
  readonly mirror: Context.Service.Shape<typeof PrMirror>;
  readonly avatars: Context.Service.Shape<typeof AvatarCache>;
}

/**
 * One repo's open PRs over GraphQL, or over the REST list when the account's
 * GraphQL budget is spent — before the call or by it.
 */
const listOpenPrs = (
  github: Github,
  gate: AccountGate,
  state: PollState,
  repo: Repository,
  accountId: string,
): Effect.Effect<OpenPrList | null> =>
  Effect.gen(function* () {
    const graphql = yield* gate.clientForAccount(accountId, "graphql");
    if (graphql) {
      const listing = yield* listOpenPrsGraphql(github, gate, state, repo, graphql, null);
      // Anything but a spent GraphQL budget is this repo's answer for the cycle.
      if (listing !== null || (yield* gate.clientForAccount(accountId, "graphql"))) return listing;
    }
    const rest = yield* gate.clientForAccount(accountId, "core");
    if (!rest) return null;
    const prs = yield* gate.guarded(
      github.prs.listOpenRest(rest, repo.fullName, repo.id),
      `listPrs (REST) error for ${repo.fullName}`,
    );
    return prs === null ? null : { prs, hostPredatesStacks: false };
  });

const listOpenPrsGraphql = (
  github: Github,
  gate: AccountGate,
  state: PollState,
  repo: Repository,
  client: GitHubClient,
  updatedSince: string | null,
): Effect.Effect<OpenPrList | null> =>
  Effect.gen(function* () {
    const key = accountHostKey(client.accountId ?? "", repo.githubHost);
    const withStacks = state.asksStacks(key, Date.now());
    const listing = yield* gate.guarded(
      github.prs.listOpen(client, repo.fullName, repo.id, { withStacks, updatedSince }),
      `listPrs error for ${repo.fullName}`,
    );
    if (listing?.hostPredatesStacks) state.noteStacksRefused(key, Date.now());
    else if (listing && withStacks) state.noteStacksAnswered(key);
    return listing;
  });

interface DeltaListing extends OpenPrList {
  readonly kept: readonly PullRequest[];
}

const listOpenPrsDelta = (
  github: Github,
  gate: AccountGate,
  state: PollState,
  ctx: RepoListingContext,
  repo: Repository,
  accountId: string,
): Effect.Effect<DeltaListing | null> =>
  Effect.gen(function* () {
    const listed = state.listed(repo.id);
    const probed = ctx.probedSignatures.get(repo.id);
    const since = listed?.signature.latestUpdatedAt ?? null;
    if (!listed || !probed || since === null) return null;
    const client = yield* gate.clientForAccount(accountId, "graphql");
    if (!client) return null;

    const [open, closed] = yield* Effect.all(
      [
        listOpenPrsGraphql(github, gate, state, repo, client, since),
        gate.guarded(
          github.prs.listClosedSince(client, repo.fullName, since),
          `closed-PR read error for ${repo.fullName}`,
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
    if (!listed.truncated && kept.length + open.prs.length !== probed.count) return null;
    return { ...open, kept };
  });

/** Null when the repo couldn't be listed this cycle; its rows are then left untouched. */
export const syncRepoOpenPrs = (
  svc: ListingServices,
  gate: AccountGate,
  state: PollState,
  ctx: RepoListingContext,
  repo: Repository,
): Effect.Effect<RepoListing | null> =>
  Effect.gen(function* () {
    const { github, mirror, avatars } = svc;
    const accountId = gate.repoToAccountId.get(repo.id);
    if (!accountId) {
      logError("PollScheduler", `skipping PR sync for ${repo.fullName}: no owning account`);
      return null;
    }
    if (!(yield* gate.clientForAccount(accountId))) return null;

    if (ctx.unchangedRepoIds.has(repo.id)) {
      return { prs: [...(ctx.existingByRepo.get(repo.id) ?? [])], listed: false };
    }

    const delta = yield* listOpenPrsDelta(github, gate, state, ctx, repo, accountId);
    const listing = delta ?? (yield* listOpenPrs(github, gate, state, repo, accountId));
    if (listing === null) return null;
    const { prs } = listing;
    const kept = delta?.kept ?? [];

    const authorsByLogin = new Map<string, string | null>();
    for (const pr of prs) {
      if (!authorsByLogin.has(pr.authorLogin))
        authorsByLogin.set(pr.authorLogin, pr.authorAvatarUrl);
    }
    for (const [login, avatarUrl] of authorsByLogin) {
      yield* avatars.ensure(repo.githubHost, login, avatarUrl);
    }

    // The list carries no diff size; one aliased GraphQL request sizes the PRs
    // never sized or whose head just moved, so steady state adds no request.
    // Decided on the masked head: sizing a stale head would persist stats over
    // a newer stored row.
    const maskedPrs = prs.map((pr) => preserveHeadOnStaleRead(ctx.existingMap.get(pr.id), pr));
    const needsStats = maskedPrs.filter((pr) =>
      needsDiffStats(ctx.existingMap.get(pr.id), ctx.diffStatsHeadByPrId.get(pr.id), pr.headSha),
    );
    // Best-effort, and skipped while the GraphQL budget is spent: unsized rows
    // keep the stored values (`upsertPrs`' `changed_files > 0` guard).
    const statsClient =
      needsStats.length === 0 ? null : yield* gate.clientForAccount(accountId, "graphql");
    const diffStats =
      statsClient === null
        ? null
        : yield* gate.guarded(
            github.prs.diffStats(
              statsClient,
              repo.fullName,
              needsStats.map((pr) => pr.externalId),
            ),
            `diffStats error for ${repo.fullName}`,
          );

    const sized = new Set(needsStats.map((pr) => pr.id));
    const rows = maskedPrs.map((pr): ObservedPr => {
      const stats = sized.has(pr.id) ? diffStats?.get(pr.externalId) : undefined;
      return stats === undefined || pr.headSha === null
        ? pr
        : { ...pr, ...stats, statsHeadSha: pr.headSha };
    });

    const outcome = yield* mirror.apply(rows, { announce: false, prior: ctx.existingMap }).pipe(
      Effect.catch((err) =>
        Effect.sync(() => {
          logError("PollScheduler", `PR write failed for ${repo.fullName}:`, err);
          return null;
        }),
      ),
    );
    const current = [...(outcome?.rows ?? []), ...kept];

    // Only a list that fully landed may stand in for the next ones: rows
    // still missing their diff stats must come back round to get them.
    const statsComplete = needsStats.every((pr) => diffStats?.has(pr.externalId) === true);
    if (outcome !== null && statsComplete) {
      const now = Date.now();
      const previous = state.listed(repo.id);
      state.recordListing(repo.id, {
        signature: signatureOfList(current),
        listedAt: now,
        fullListedAt: delta ? (previous?.fullListedAt ?? now) : now,
        hasStacks: current.some((pr) => pr.stack !== null),
        truncated: delta ? (previous?.truncated ?? false) : prs.length >= OPEN_PRS_LIST_CAP,
      });
    } else {
      state.forgetListing(repo.id);
    }

    if (outcome === null) return null;
    yield* Effect.annotateCurrentSpan("prs_open", current.length);
    return { prs: current, listed: true };
  }).pipe(
    Effect.withSpan("PollScheduler.syncRepo", {
      attributes: { repo: repo.fullName, repoId: repo.id },
    }),
  );

/**
 * Settle PRs that were open before but are gone from GitHub's open list: one
 * batched read per repo learns whether each merged or closed (and its final
 * diff size), and `PrMirror` archives it. A PR GitHub can no longer show is
 * recorded closed. When the read can't be made this cycle — no budget, a
 * failure — the PRs stay open and the next cycle asks again, so a merge is
 * never recorded as a close for want of asking. Returns the PRs that went
 * terminal.
 */
export const settleVanishedPrs = (
  svc: Pick<ListingServices, "github" | "mirror">,
  gate: AccountGate,
  vanished: readonly PullRequest[],
  repoById: ReadonlyMap<string, Repository>,
  prior: ReadonlyMap<string, PullRequest>,
): Effect.Effect<string[]> =>
  Effect.gen(function* () {
    const settled: string[] = [];
    yield* Effect.forEach(
      Map.groupBy(vanished, (pr) => pr.repositoryId),
      ([repoId, prs]) =>
        Effect.gen(function* () {
          const repo = repoById.get(repoId);
          const client = repo ? yield* gate.clientForRepo(repoId, "graphql") : null;
          if (!repo || !client) return;
          const fetched = yield* gate.guarded(
            svc.github.prs.getMany(
              client,
              repo.fullName,
              repo.id,
              prs.map((pr) => pr.externalId),
            ),
            `closed-PR status read failed for ${repo.fullName}`,
          );
          if (!fetched) return;
          const now = new Date().toISOString();
          const observed = prs.map(
            (pr): ObservedPr =>
              fetched.get(pr.externalId) ?? {
                ...pr,
                stack: STACK_UNSEEN,
                status: "closed",
                closedAt: now,
                fetchedAt: now,
              },
          );
          const outcome = yield* svc.mirror.apply(observed, { announce: false, prior }).pipe(
            Effect.catch((err) =>
              Effect.sync(() => {
                logError("PollScheduler", `archiving closed PRs of ${repo.fullName}:`, err);
                return null;
              }),
            ),
          );
          for (const row of outcome?.rows ?? []) if (row.status !== "open") settled.push(row.id);
        }),
      { concurrency: 3, discard: true },
    );
    return settled;
  });
