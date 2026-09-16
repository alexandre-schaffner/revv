/**
 * Pure logic behind the repo homepage's "needs your attention" list.
 *
 * Kept free of runes and of Svelte imports so the classification and the
 * comparator can be unit-tested directly, and so both the store (which builds
 * the tagged set) and the component (which sorts it) read the same rules.
 */

import { loginsMatch, type PullRequest } from "@revv/shared";

/**
 * Why a PR is on your queue. Mutually exclusive by construction — see
 * {@link reasonFor} for the precedence.
 */
export type TaggedReason = "review" | "yours" | "mentioned";

export interface TaggedRow {
  readonly pr: PullRequest;
  readonly reason: TaggedReason;
}

/**
 * Relevance order — the single source for both the toolbar's filter order and
 * the default sort's ranking.
 *
 * A review someone explicitly asked you for is unambiguously actionable, so it
 * leads. Your own PRs come next: they may be approved and waiting to merge, or
 * stalled. A bare @-mention is the weakest signal — often a drive-by.
 */
export const REASON_ORDER = [
  "review",
  "yours",
  "mentioned",
] as const satisfies readonly TaggedReason[];

/**
 * Relevance rank by position in {@link REASON_ORDER}, so the toolbar's display
 * order and the default sort's ranking cannot drift apart. They were two
 * literals reconciled by a comment saying "matches" — which is a claim no
 * compiler was checking.
 */
const REASON_RANK: Record<TaggedReason, number> = Object.fromEntries(
  REASON_ORDER.map((reason, index) => [reason, index]),
) as Record<TaggedReason, number>;

export const REASON_LABEL: Record<TaggedReason, string> = {
  review: "Review requested",
  yours: "Yours",
  mentioned: "Mentioned",
};

/**
 * Classify one PR against a login, or `null` if the login isn't involved.
 *
 * Precedence matters and is not arbitrary: a requested review outranks
 * authorship because it is the actionable state, and authorship outranks a
 * mention because authors are routinely @-mentioned in their own PR's
 * comment threads, which would otherwise mislabel most of your own work.
 *
 * `login` is nullable because `getCurrentUserLogin()` is null until identity
 * resolves; callers must treat `null` as "unknown", never as "no results".
 */
export function reasonFor(pr: PullRequest, login: string | null): TaggedReason | null {
  if (!login) return null;
  // `loginsMatch`, not `===`/`includes`: GitHub logins are case-insensitive and
  // the casing we hold for the viewer comes from a different endpoint than the
  // casing on the PR. An exact match drops rows out of the queue silently.
  if (pr.requestedReviewers.some((r) => loginsMatch(r, login))) return "review";
  if (loginsMatch(pr.authorLogin, login)) return "yours";
  if (pr.mentionedUsers.some((m) => loginsMatch(m, login))) return "mentioned";
  return null;
}

/** Classify a PR list, dropping the ones the login isn't involved in. */
export function toTaggedRows(prs: readonly PullRequest[], login: string | null): TaggedRow[] {
  if (!login) return [];
  const rows: TaggedRow[] = [];
  for (const pr of prs) {
    const reason = reasonFor(pr, login);
    if (reason !== null) rows.push({ pr, reason });
  }
  return rows;
}

/**
 * What the list can be ordered by.
 *
 * `"default"` is relevance (reason rank, then recency) — not a field, but "how
 * much each row wants your attention". The others are the two fields worth
 * ordering by.
 *
 * Reason, author and branch are deliberately absent. Reason is a *filter* here,
 * not an order (the toolbar narrows to one), and author is already filterable
 * from the sidebar.
 */
export type TaggedSortKey = "default" | "pr" | "updated";

export type SortDir = "asc" | "desc";

/**
 * The sort menu, in display order.
 *
 * Labels are GitHub's own sort vocabulary, so a reviewer who has used
 * github.com/pulls recognises every entry. `id` exists because a
 * (key, dir) pair is not a usable `<select>` value; it is the only thing the
 * component holds in state.
 */
export const TAGGED_SORT_OPTIONS = [
  { id: "relevance", label: "Relevance", key: "default", dir: "asc" },
  { id: "updated-desc", label: "Recently updated", key: "updated", dir: "desc" },
  { id: "updated-asc", label: "Least recently updated", key: "updated", dir: "asc" },
  { id: "number-desc", label: "Newest", key: "pr", dir: "desc" },
  { id: "number-asc", label: "Oldest", key: "pr", dir: "asc" },
] as const satisfies ReadonlyArray<{
  id: string;
  label: string;
  key: TaggedSortKey;
  dir: SortDir;
}>;

export type TaggedSortId = (typeof TAGGED_SORT_OPTIONS)[number]["id"];

/**
 * Falls back to relevance so an unknown id can never leave the list unsorted.
 *
 * Takes `string`, not `TaggedSortId`: the only caller is a `<Select>` whose
 * primitive hands back a bare string, and narrowing here is what keeps that
 * call site free of an `as`.
 */
export function sortOptionFor(id: string): (typeof TAGGED_SORT_OPTIONS)[number] {
  return TAGGED_SORT_OPTIONS.find((o) => o.id === id) ?? TAGGED_SORT_OPTIONS[0];
}

/**
 * Milliseconds for a wire timestamp.
 *
 * Normalisation is required, not defensive: the two paths that fill the PR
 * store disagree about types. The Eden treaty client runs a `JSON.parse`
 * reviver that turns any value matching its ISO-8601 / loose-date regexes into
 * a `Date`, while the SSE path (`prs:updated` → plain `JSON.parse`) leaves it a
 * string. So `updatedAt` is a `Date` after a fetch and a `string` after a
 * broadcast, in the same array, with the DTO typing both as `string`. Calling
 * `.localeCompare` on it throws `localeCompare is not a function` and takes the
 * whole page render down with it.
 *
 * `new Date()` handles both. Unparseable values sort as oldest rather than
 * poisoning the comparison with `NaN`, which would make the sort
 * non-transitive.
 */
function timeOf(value: string): number {
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * Recency, then PR number, both descending. Applied under every sort key so
 * the comparator is a total order — without it, rows that tie on the visible
 * column would reshuffle on unrelated SSE ticks.
 */
function tiebreak(a: TaggedRow, b: TaggedRow): number {
  const byUpdated = timeOf(b.pr.updatedAt) - timeOf(a.pr.updatedAt);
  return byUpdated !== 0 ? byUpdated : b.pr.externalId - a.pr.externalId;
}

export function compareTaggedRows(
  a: TaggedRow,
  b: TaggedRow,
  key: TaggedSortKey,
  dir: SortDir,
): number {
  if (key === "default") {
    const byRank = REASON_RANK[a.reason] - REASON_RANK[b.reason];
    return byRank !== 0 ? byRank : tiebreak(a, b);
  }

  let primary = 0;
  switch (key) {
    case "pr":
      primary = a.pr.externalId - b.pr.externalId;
      break;
    case "updated":
      primary = timeOf(a.pr.updatedAt) - timeOf(b.pr.updatedAt);
      break;
  }

  if (primary === 0) return tiebreak(a, b);
  return dir === "asc" ? primary : -primary;
}
