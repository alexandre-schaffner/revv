// "GitHub reports a head SHA that differs from the stored one: did the head
// really move forward?"
//
// The answer is destructive. A head move makes PrMirror call
// `WalkthroughJobs.supersedeForPr(prId, newHeadSha)`, which cancels every
// walkthrough for the PR not pinned to `newHeadSha` and marks it `'superseded'`.
// If `newHeadSha` is an *older* view of the PR, that kills the walkthrough
// generating at the real head, leaving a contentless superseded row that also
// poisons the next incremental run's base SHA.
//
// Stale reads are normal. GitHub's list-PRs endpoint (the poll's source) is
// cache-fronted and lags the PR detail endpoint that `refreshPr` and the
// walkthrough job read, and the ETag cache in front of it replays bodies that
// were already stale when cached. A push, a single-PR sync and a review started
// inside the list endpoint's cache window is enough.
//
// `updated_at` is the tiebreaker: GitHub bumps it on every push, so a payload
// whose `updated_at` predates the stored one cannot describe a newer head.
// SQLite is authoritative (invariant 1): the stored view stands, and a later
// read with a newer `updated_at` acts.

export interface PrHeadSnapshot {
  readonly headSha: string | null;
  /** GitHub's `updated_at`, ISO 8601. Monotonic per PR. */
  readonly updatedAt: string;
}

/**
 * The fields a stale read must not be allowed to write.
 *
 * Wider than `PrHeadSnapshot` because the *verdict* needs only the head, while
 * the *write mask* must keep the whole diff range coherent. `base_sha` and
 * `head_sha` are consumed as a pair — `routes/prs.ts` calls
 * `compareFiles(baseSha, headSha)`, the diff cache keys on both — so masking one
 * and writing the other produces a range GitHub never reported.
 */
export interface PrRangeSnapshot extends PrHeadSnapshot {
  readonly baseSha: string | null;
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
 * Gating the supersede alone is not enough: writing a stale body's older
 * `head_sha` and `updated_at` would regress everything head-derived (the web's
 * "new commits → Pull" and "New commits" tint, the walkthrough snapshot's
 * `stale` flag), and the regressed `updated_at` would let the next cycle's
 * `>=` check pass against the stale row.
 *
 * Only the three range-bearing fields are masked. Everything else in the
 * payload (title, draft state, reviewers, counts) is still worth writing; a
 * stale read is stale about the head, not corrupt.
 *
 * `baseSha` travels with `headSha` because the two are only ever read as a
 * pair. Keeping the stored head while writing the stale body's base would
 * compute the PR diff over `(staleBase, storedHead)` — a range that describes
 * no commit either side ever produced, and one the `(headSha, baseSha)` diff
 * cache key would then treat as a legitimate miss and re-fetch.
 */
export function preserveHeadOnStaleRead<T extends PrRangeSnapshot>(
  stored: PrRangeSnapshot | undefined,
  fresh: T,
): Omit<T, keyof PrRangeSnapshot> & PrRangeSnapshot {
  if (stored === undefined || !regressesStoredHead(stored, fresh)) return fresh;
  return {
    ...fresh,
    headSha: stored.headSha,
    baseSha: stored.baseSha,
    updatedAt: stored.updatedAt,
  };
}
