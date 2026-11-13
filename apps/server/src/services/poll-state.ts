/**
 * What the poll remembers between cycles, owned in one place. Every entry is a
 * reconstructible coordination cache (invariant 1): losing it on restart costs
 * one full re-list per repo, one extra thread sweep per PR and an early
 * maintenance pass.
 */
import { FRESHEN_MIN_INTERVAL_MS, type PullRequest } from "@revv/shared";
import type { OpenPrListSignature } from "./github/pulls";

/** The last list of a repo that landed in SQLite, as its signature. */
export interface ListedSignature {
  readonly signature: OpenPrListSignature;
  readonly listedAt: number;
  readonly fullListedAt: number;
  readonly hasStacks: boolean;
  readonly truncated: boolean;
}

export interface ThreadSweepMark {
  readonly updatedAt: string;
  readonly sweptAt: number;
}

/**
 * How often the sweep re-reads a PR whose `updatedAt` hasn't moved but which
 * still has an unresolved thread. GitHub doesn't bump `updatedAt` on a
 * resolve/unresolve, so such a PR can only be caught by asking again; opening
 * the PR syncs its threads on demand, so this only bounds how stale the list's
 * counts get.
 */
const THREAD_RECHECK_INTERVAL_MS = 30 * 60 * 1000;

/** What started a cycle. `manual` is the user's refresh button. */
export type SyncTrigger = "periodic" | "manual" | "freshen";

/** Re-list a host that refused the stack fields again after this long. */
const STACKLESS_RECHECK_MS = 30 * 60 * 1000;

export function rankThreadSweep<P extends Pick<PullRequest, "id" | "updatedAt">>(
  openPrs: readonly P[],
  marks: ReadonlyMap<string, ThreadSweepMark>,
  now: number,
): Array<{ readonly pr: P; readonly recheck: boolean }> {
  const moved: P[] = [];
  const unseen: P[] = [];
  const recheck: Array<{ readonly pr: P; readonly sweptAt: number }> = [];
  for (const pr of openPrs) {
    const mark = marks.get(pr.id);
    if (mark === undefined) unseen.push(pr);
    else if (mark.updatedAt !== pr.updatedAt) moved.push(pr);
    else if (now - mark.sweptAt >= THREAD_RECHECK_INTERVAL_MS) {
      recheck.push({ pr, sweptAt: mark.sweptAt });
    }
  }
  recheck.sort((a, b) => a.sweptAt - b.sweptAt);
  return [
    ...[...moved, ...unseen].map((pr) => ({ pr, recheck: false })),
    ...recheck.map(({ pr }) => ({ pr, recheck: true })),
  ];
}

export interface PollState {
  readonly listed: (repoId: string) => ListedSignature | undefined;
  readonly recordListing: (repoId: string, listed: ListedSignature) => void;
  /** Forget a repo's list, so the next cycle lists it in full. */
  readonly forgetListing: (repoId: string) => void;
  readonly keepListingsFor: (repoIds: ReadonlySet<string>) => void;

  /** Whether to ask this account+host for stacks, or it recently refused them. */
  readonly asksStacks: (accountHost: string, now: number) => boolean;
  readonly noteStacksRefused: (accountHost: string, now: number) => void;
  readonly noteStacksAnswered: (accountHost: string) => void;

  readonly sweepOrder: <P extends Pick<PullRequest, "id" | "updatedAt">>(
    openPrs: readonly P[],
    now: number,
  ) => Array<{ readonly pr: P; readonly recheck: boolean }>;
  readonly noteSwept: (pr: Pick<PullRequest, "id" | "updatedAt">, now: number) => void;
  readonly keepSweptFor: (openPrIds: ReadonlySet<string>) => void;

  /** Whether a pass is due, claiming it if so. Due at once after boot. */
  readonly claimDue: (
    pass: "metadata" | "archive-backfill",
    intervalMs: number,
    now: number,
  ) => boolean;

  /**
   * Claim the one cycle that may run. Concurrent callers coalesce onto the
   * one in flight; `freshen` also skips when a cycle started recently. A
   * `manual` request that coalesces asks for one more cycle after the one in
   * flight (it may be about a repo that cycle already listed past), and its
   * `requesters` (local users) are recorded for that follow-up.
   */
  readonly claimCycle: (
    trigger: SyncTrigger,
    now: number,
    requesters?: ReadonlySet<string>,
  ) => "claimed" | "in-flight" | "fresh-enough";
  /**
   * Release the cycle. Resolves the requesters of the follow-up a `manual`
   * request asked for, or null when none did.
   */
  readonly releaseCycle: () => ReadonlySet<string> | null;

  /**
   * Whether a cycle has completed since boot. The first is a baseline: it
   * can't tell what changed since the previous server run, so it raises no
   * notifications.
   */
  readonly baselineDone: () => boolean;
  readonly markBaselineDone: () => void;
}

export function makePollState(): PollState {
  const listings = new Map<string, ListedSignature>();
  const stacklessUntil = new Map<string, number>();
  const sweepMarks = new Map<string, ThreadSweepMark>();
  const lastPassAt = new Map<string, number>();
  let inFlight = false;
  let followUp: Set<string> | null = null;
  let lastCycleStartedAt = 0;
  let baseline = false;

  return {
    listed: (repoId) => listings.get(repoId),
    recordListing: (repoId, listed) => {
      listings.set(repoId, listed);
    },
    forgetListing: (repoId) => {
      listings.delete(repoId);
    },
    keepListingsFor: (repoIds) => {
      for (const repoId of listings.keys()) if (!repoIds.has(repoId)) listings.delete(repoId);
    },

    asksStacks: (accountHost, now) => {
      const until = stacklessUntil.get(accountHost);
      return until === undefined || now >= until;
    },
    noteStacksRefused: (accountHost, now) => {
      stacklessUntil.set(accountHost, now + STACKLESS_RECHECK_MS);
    },
    noteStacksAnswered: (accountHost) => {
      stacklessUntil.delete(accountHost);
    },

    sweepOrder: (openPrs, now) => rankThreadSweep(openPrs, sweepMarks, now),
    noteSwept: (pr, now) => {
      sweepMarks.set(pr.id, { updatedAt: pr.updatedAt, sweptAt: now });
    },
    keepSweptFor: (openPrIds) => {
      for (const id of sweepMarks.keys()) if (!openPrIds.has(id)) sweepMarks.delete(id);
    },

    claimDue: (pass, intervalMs, now) => {
      const last = lastPassAt.get(pass) ?? 0;
      if (now - last < intervalMs) return false;
      lastPassAt.set(pass, now);
      return true;
    },

    claimCycle: (trigger, now, requesters = new Set()) => {
      if (inFlight) {
        if (trigger === "manual") followUp = new Set([...(followUp ?? []), ...requesters]);
        return "in-flight";
      }
      if (trigger === "freshen" && now - lastCycleStartedAt < FRESHEN_MIN_INTERVAL_MS) {
        return "fresh-enough";
      }
      inFlight = true;
      lastCycleStartedAt = now;
      return "claimed";
    },
    releaseCycle: () => {
      inFlight = false;
      const requesters = followUp;
      followUp = null;
      return requesters;
    },

    baselineDone: () => baseline,
    markBaselineDone: () => {
      baseline = true;
    },
  };
}
