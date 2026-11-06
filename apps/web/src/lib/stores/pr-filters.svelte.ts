// The sidebar's PR list as the user narrowed it: the search box and the
// creator/team filter, and the per-repo order the list shows.

import type { PullRequest } from "@revv/shared";
import { loginsMatch } from "@revv/shared";
import { getCurrentUserLogin } from "$lib/stores/auth.svelte";
import { fuzzyScore } from "$lib/utils/fuzzy";
import { getPullRequests, isPrPinned, setArchiveAuthors } from "./prs.svelte";
import { getRepositories } from "./repos.svelte";

let searchQuery = $state("");
let selectedAuthorLogins = $state<Set<string>>(new Set());

const authorFilteredPrs = $derived.by((): PullRequest[] => {
  const prs = getPullRequests();
  if (selectedAuthorLogins.size === 0) return prs;
  return prs.filter((pr) => selectedAuthorLogins.has(pr.authorLogin));
});

// The search uses the Cmd+P palette's fuzzy scorer, so "auth jw" matches
// "Add JWT auth middleware". A PR scores its best field among title, source
// branch, `#number`, author and repo; with a query the list sorts by score,
// without one it keeps the server's order.
const filteredPrs = $derived.by((): PullRequest[] => {
  const q = searchQuery.trim();
  if (q === "") return authorFilteredPrs;

  const repoMap = new Map(getRepositories().map((r) => [r.id, r]));

  return authorFilteredPrs
    .map((pr) => {
      const repoName = repoMap.get(pr.repositoryId)?.fullName ?? "";
      const score = Math.max(
        fuzzyScore(q, pr.title),
        fuzzyScore(q, pr.sourceBranch),
        fuzzyScore(q, `#${pr.externalId}`),
        fuzzyScore(q, pr.authorLogin),
        fuzzyScore(q, repoName),
      );
      return { pr, score };
    })
    .filter((r) => r.score >= 0)
    .sort((a, b) => b.score - a.score)
    .map((r) => r.pr);
});

const groupedByRepo = $derived(Map.groupBy(filteredPrs, (pr) => pr.repositoryId));

const needsYourReviewByRepo = $derived.by((): Map<string, PullRequest[]> => {
  const login = getCurrentUserLogin();
  if (!login) return new Map();
  const needsReview = filteredPrs.filter((pr) =>
    pr.requestedReviewers.some((r) => loginsMatch(r, login)),
  );
  return Map.groupBy(needsReview, (pr) => pr.repositoryId);
});

/**
 * Open PRs for one repo with pinned PRs sorted to the very top, then
 * needs-your-review PRs, then the rest.
 */
export function getOpenPrsByRepoOrdered(repoId: string): PullRequest[] {
  const all = groupedByRepo.get(repoId) ?? [];
  const pinned = all.filter((p) => isPrPinned(p.id));
  const review = (needsYourReviewByRepo.get(repoId) ?? []).filter((p) => !isPrPinned(p.id));
  const skipIds = new Set([...pinned.map((p) => p.id), ...review.map((p) => p.id)]);
  const rest = all.filter((p) => !skipIds.has(p.id));
  return [...pinned, ...review, ...rest];
}

export function hasActivePrListFilter(): boolean {
  return searchQuery.trim() !== "" || selectedAuthorLogins.size > 0;
}

export function setSearchQuery(q: string): void {
  searchQuery = q;
}

export interface PrAuthorFilterOption {
  readonly login: string;
  readonly count: number;
  readonly avatarContent: string | null;
}

type AuthorAccumulator = Map<string, { count: number; avatarContent: string | null }>;

function tallyAuthor(counts: AuthorAccumulator, pr: PullRequest): void {
  const existing = counts.get(pr.authorLogin);
  if (existing) {
    existing.count += 1;
    existing.avatarContent ??= pr.authorAvatarContent;
  } else {
    counts.set(pr.authorLogin, { count: 1, avatarContent: pr.authorAvatarContent });
  }
}

function toSortedOptions(counts: AuthorAccumulator): PrAuthorFilterOption[] {
  return [...counts.entries()]
    .map(([login, value]) => ({ login, ...value }))
    .sort((a, b) => b.count - a.count || a.login.localeCompare(b.login));
}

// Rebuilt only when the open-PR list changes, never when the filter popover
// opens, so opening it is a lookup even on repos with hundreds of contributors.
const authorOptionsByRepo = $derived.by((): Map<string, PrAuthorFilterOption[]> => {
  const byRepo = new Map<string, AuthorAccumulator>();
  for (const pr of getPullRequests()) {
    let counts = byRepo.get(pr.repositoryId);
    if (!counts) {
      counts = new Map();
      byRepo.set(pr.repositoryId, counts);
    }
    tallyAuthor(counts, pr);
  }
  const result = new Map<string, PrAuthorFilterOption[]>();
  for (const [repoId, counts] of byRepo) result.set(repoId, toSortedOptions(counts));
  return result;
});

const allAuthorOptions = $derived.by((): PrAuthorFilterOption[] => {
  const counts: AuthorAccumulator = new Map();
  for (const pr of getPullRequests()) tallyAuthor(counts, pr);
  return toSortedOptions(counts);
});

/**
 * Author options for the raw open-PR list. They ignore the search and the
 * current author filter, so the user can recover from an over-narrow view
 * without clearing other controls first.
 */
export function getAuthorFilterOptions(repoId?: string): PrAuthorFilterOption[] {
  if (!repoId) return allAuthorOptions;
  return authorOptionsByRepo.get(repoId) ?? [];
}

export function getSelectedAuthorLogins(): Set<string> {
  return selectedAuthorLogins;
}

/** The closed list is filtered by author server-side, so it reloads with the filter. */
function applyAuthorFilter(next: Set<string>): void {
  selectedAuthorLogins = next;
  setArchiveAuthors(next);
}

export function toggleAuthorFilter(login: string): void {
  const next = new Set(selectedAuthorLogins);
  if (next.has(login)) next.delete(login);
  else next.add(login);
  applyAuthorFilter(next);
}

/** Add or remove a batch of logins in one update (selecting or deselecting a team). */
export function setAuthorFilters(logins: readonly string[], selected: boolean): void {
  if (logins.length === 0) return;
  const next = new Set(selectedAuthorLogins);
  for (const login of logins) {
    if (selected) next.add(login);
    else next.delete(login);
  }
  applyAuthorFilter(next);
}

export function clearAuthorFilters(): void {
  if (selectedAuthorLogins.size === 0) return;
  applyAuthorFilter(new Set());
}

export function reset(): void {
  searchQuery = "";
  selectedAuthorLogins = new Set();
}
