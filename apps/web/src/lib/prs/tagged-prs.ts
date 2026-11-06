/** Rules for the repo homepage's "needs your attention" list. */

import { loginsMatch, type PullRequest } from "@revv/shared";

export type TaggedReason = "review" | "yours" | "mentioned";

export interface TaggedRow {
  readonly pr: PullRequest;
  readonly reason: TaggedReason;
}

/**
 * Relevance order, for both the toolbar's filters and the default sort. A
 * requested review is unambiguously actionable, so it leads; your own PRs may
 * be waiting to merge or stalled; a bare @-mention is often a drive-by.
 */
export const REASON_ORDER = [
  "review",
  "yours",
  "mentioned",
] as const satisfies readonly TaggedReason[];

const REASON_RANK: Record<TaggedReason, number> = Object.fromEntries(
  REASON_ORDER.map((reason, index) => [reason, index]),
) as Record<TaggedReason, number>;

export const REASON_LABEL: Record<TaggedReason, string> = {
  review: "Review requested",
  yours: "Yours",
  mentioned: "Mentioned",
};

/**
 * A requested review outranks authorship because it is the actionable state;
 * authorship outranks a mention because authors are routinely @-mentioned in
 * their own PR's threads.
 *
 * `login` is null until identity resolves; callers must treat it as
 * "unknown", never as "no results".
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
 * `"default"` is relevance (reason rank, then recency). Reason is a filter
 * here, not an order, and author is already filterable from the sidebar.
 */
export type TaggedSortKey = "default" | "pr" | "updated";

export type SortDir = "asc" | "desc";

/**
 * The sort menu, in display order. Labels are GitHub's own sort vocabulary,
 * so a reviewer who has used github.com/pulls recognises every entry.
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

/** An unknown id (say, persisted before a rename) falls back to relevance. */
export function sortOptionFor(id: string): (typeof TAGGED_SORT_OPTIONS)[number] {
  return TAGGED_SORT_OPTIONS.find((o) => o.id === id) ?? TAGGED_SORT_OPTIONS[0];
}

/** Unparseable values sort as oldest: `NaN` would make the sort non-transitive. */
function timeOf(value: string): number {
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * Applied under every sort key so the comparator is a total order: rows that
 * tie on the visible column must not reshuffle on unrelated SSE ticks.
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

export type TaggedEntry =
  | { readonly kind: "row"; readonly row: TaggedRow }
  | {
      readonly kind: "stack";
      readonly number: number;
      readonly members: readonly [TaggedRow, ...TaggedRow[]];
      readonly base: string;
    };

export function groupStacks(rows: readonly TaggedRow[]): TaggedEntry[] {
  const byStack = new Map<number, TaggedRow[]>();
  for (const row of rows) {
    const { stack } = row.pr;
    if (stack === null) continue;
    const members = byStack.get(stack.number);
    if (members) members.push(row);
    else byStack.set(stack.number, [row]);
  }

  const entries: TaggedEntry[] = [];
  for (const row of rows) {
    const { stack } = row.pr;
    if (stack === null) {
      entries.push({ kind: "row", row });
      continue;
    }
    const members = byStack.get(stack.number);
    if (members === undefined) continue;
    byStack.delete(stack.number);
    members.sort((a, b) => (b.pr.stack?.position ?? 0) - (a.pr.stack?.position ?? 0));
    const [top, ...rest] = members;
    const bottom = rest.at(-1);
    if (top === undefined || bottom === undefined) {
      entries.push({ kind: "row", row });
      continue;
    }
    entries.push({
      kind: "stack",
      number: stack.number,
      members: [top, ...rest],
      base: bottom.pr.targetBranch,
    });
  }
  return entries;
}

export const STACK_FOLD_AT = 3;

export function isStackOpen(size: number, chosen: boolean | undefined): boolean {
  return chosen ?? size < STACK_FOLD_AT;
}
