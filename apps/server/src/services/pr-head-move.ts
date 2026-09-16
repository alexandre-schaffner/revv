// ── Head-SHA move verdict ──────────────────────────────────────────────────
//
// Answers one question for the poll paths: "GitHub just told us this PR's head
// SHA differs from the one we have stored — did the head really move forward?"
//
// The question matters because the answer is destructive. A head-SHA move makes
// PollScheduler call `WalkthroughJobs.supersedeForPr(prId, newHeadSha)`, which
// cancels every in-flight walkthrough fiber for that PR whose `prHeadSha` is
// not `newHeadSha` and marks its row `'superseded'`. If `newHeadSha` is itself
// an *older* view of the PR, that sweep kills the walkthrough generating at the
// real head: the row ends up `'superseded'` with zero content, the UI drops to
// "No walkthrough generated yet for this PR" plus the outdated-walkthrough
// toast, and the contentless row goes on to poison the next incremental run's
// base SHA.
//
// Stale reads are normal, not exotic. GitHub's list-PRs endpoint (the poll's
// source) is cache-fronted and lags the PR *detail* endpoint that `refreshPr`
// and the walkthrough job read from, and the ETag cache in front of it happily
// replays a body that was already stale when it was cached. So "list says
// cc7d62f, we already know c5f7ac2" happens whenever the user pushes, syncs the
// single PR, and starts a review inside the list endpoint's cache window.
//
// `updated_at` is the tiebreaker: GitHub bumps it on every push, so a payload
// whose `updated_at` predates what we already stored cannot be describing a
// newer head. SQLite is authoritative (CLAUDE.md invariant #1) — when the fresh
// read is provably older than the stored row, we keep the stored view and let a
// later cycle (which will see a monotonically newer `updated_at`) act.

/** The subset of a PR row / payload needed to judge a head-SHA move. */
export interface PrHeadSnapshot {
  readonly headSha: string | null;
  /** GitHub's `updated_at`, ISO 8601. Monotonic per PR. */
  readonly updatedAt: string;
}

/**
 * `true` when `fresh` is a trustworthy report that the PR's head moved off
 * `stored.headSha`, i.e. the caller may supersede walkthroughs pinned to
 * anything other than `fresh.headSha`.
 *
 * Returns `false` — meaning "do nothing this cycle" — when:
 *   • the SHAs agree (no move at all);
 *   • `fresh.headSha` is null (a payload with no head tells us nothing, and
 *     passing `undefined` as `exceptHeadSha` downstream would sweep *every*
 *     walkthrough for the PR, in-flight ones included);
 *   • `fresh.updatedAt` predates `stored.updatedAt` (a stale read).
 */
export function isTrustedHeadShaMove(stored: PrHeadSnapshot, fresh: PrHeadSnapshot): boolean {
  if (fresh.headSha === null) return false;
  if (stored.headSha === fresh.headSha) return false;
  // No stored head yet → nothing to regress against; the fresh value wins.
  if (stored.headSha === null) return true;
  // Equal timestamps pass: two pushes inside the same second are legitimate,
  // and only a strictly-older payload proves a stale read.
  return fresh.updatedAt >= stored.updatedAt;
}

/**
 * `true` when `fresh` is provably an *older* view of the PR than `stored`, or
 * carries no head at all — either way it must not be allowed to move
 * `head_sha`.
 *
 * Distinct from `!isTrustedHeadShaMove`, which is also false in the ordinary
 * "nothing moved" case. This asks the narrower question the write path cares
 * about: would applying this payload lose information we already have?
 */
function regressesStoredHead(stored: PrHeadSnapshot, fresh: PrHeadSnapshot): boolean {
  if (stored.headSha === null) return false;
  if (stored.headSha === fresh.headSha) return false;
  return fresh.headSha === null || fresh.updatedAt < stored.updatedAt;
}

/**
 * Keep the stored head when `fresh` is a stale read, returning the row to write.
 *
 * Gating only the *supersede* on `isTrustedHeadShaMove` was half a fix: the
 * upsert ran first and unconditionally, so a lagging list body still wrote its
 * older `head_sha` and `updated_at` into `pull_requests`. Everything
 * head-derived then read the stale value — the "new commits → Pull" affordance,
 * `getVisitState`'s "New commits" row tint, the walkthrough snapshot's `stale`
 * flag — and, worse, the regressed `updated_at` re-opened the gate: the next
 * cycle compares against the row the stale read just wrote, so `>=` passes
 * trivially and the protection lasts exactly one cycle.
 *
 * SQLite is authoritative (CLAUDE.md invariant #1). When the fresh read is
 * provably older, the stored view stands and a later cycle — which will carry a
 * monotonically newer `updated_at` — is the one that acts.
 *
 * Only the two head-bearing fields are masked. Everything else in the payload
 * (title, draft state, reviewers, counts) is still worth writing; a stale read
 * is stale about the head, not corrupt.
 */
export function preserveHeadOnStaleRead<T extends PrHeadSnapshot>(
  stored: PrHeadSnapshot | undefined,
  fresh: T,
): Omit<T, keyof PrHeadSnapshot> & PrHeadSnapshot {
  if (stored === undefined || !regressesStoredHead(stored, fresh)) return fresh;
  return { ...fresh, headSha: stored.headSha, updatedAt: stored.updatedAt };
}
