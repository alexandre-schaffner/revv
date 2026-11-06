/**
 * What the poll remembers between cycles, owned in one place. Every entry is a
 * reconstructible coordination cache (invariant 1): losing it on restart costs
 * one full re-list per repo, one extra thread sweep per PR and an early
 * maintenance pass.
 */
import type { PullRequest } from "@revv/shared";
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

/**
 * How recently a cycle must have started for `freshen` to skip. Every window
 * open and focus asks for one; this keeps alt-tabbing (or several windows)
 * from becoming a cycle per event.
 */
const FRESHEN_MIN_INTERVAL_MS = 2 * 60 * 1000;

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
  /** The signature of the repo's last list that landed, if still remembered. */
  readonly listed: (repoId: string) => ListedSignature | undefined;
  readonly recordListing: (repoId: string, listed: ListedSignature) => void;
  /** Forget a repo's list, so the next cycle lists it in full. */
  readonly forgetListing: (repoId: string) => void;
  /** Drop what's remembered for repos no longer tracked. */
  readonly keepListingsFor: (repoIds: ReadonlySet<string>) => void;

  /** Whether to ask this account+host for stacks, or it recently refused them. */
  readonly asksStacks: (accountHost: string, now: number) => boolean;
  readonly noteStacksRefused: (accountHost: string, now: number) => void;
  readonly noteStacksAnswered: (accountHost: string) => void;

  /** Open PRs in the order the thread sweep should visit them. */
  readonly sweepOrder: <P extends Pick<PullRequest, "id" | "updatedAt">>(
    openPrs: readonly P[],
    now: number,
  ) => Array<{ readonly pr: P; readonly recheck: boolean }>;
  readonly noteSwept: (pr: Pick<PullRequest, "id" | "updatedAt">, now: number) => void;
  /** Drop sweep marks of PRs that left the open list. */
  readonly keepSweptFor: (openPrIds: ReadonlySet<string>) => void;

  /** Whether an hourly pass is due; claims it when it is. Due at once after boot. */
  readonly claimDue: (
    pass: "metadata" | "archive-backfill",
    intervalMs: number,
    now: number,
  ) => boolean;

  /**
   * Claim the one cycle that may run. Concurrent callers coalesce onto the
   * one in flight; `freshen` also skips when a cycle started recently.
   */
  readonly claimCycle: (
    trigger: SyncTrigger,
    now: number,
  ) => "claimed" | "in-flight" | "fresh-enough";
  readonly releaseCycle: () => void;

  /**
   * Whether a periodic cycle has completed. The first is a baseline: it can't
   * tell what changed since the previous server run, so it raises no
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

    claimCycle: (trigger, now) => {
      if (inFlight) return "in-flight";
      if (trigger === "freshen" && now - lastCycleStartedAt < FRESHEN_MIN_INTERVAL_MS) {
        return "fresh-enough";
      }
      inFlight = true;
      lastCycleStartedAt = now;
      return "claimed";
    },
    releaseCycle: () => {
      inFlight = false;
    },

    baselineDone: () => baseline,
    markBaselineDone: () => {
      baseline = true;
    },
  };
}
