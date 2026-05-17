import type { CloneStatus, PullRequest, Repository, ThreadSummary } from "@revv/shared";
import { toast } from "svelte-sonner";
import { goto } from "$app/navigation";
import { api } from "$lib/api/client";
import { getCurrentUserLogin } from "$lib/stores/auth.svelte";
import { getActiveOrg } from "$lib/stores/orgs.svelte";

import { setBatchSummaries } from "$lib/stores/sync.svelte";
import { fuzzyScore } from "$lib/utils/fuzzy";

let pullRequests = $state<PullRequest[]>([]);
let repositories = $state<Repository[]>([]);
let availableRepos = $state<Repository[]>([]);
let availableReposLoading = $state(false);
let availableReposFetchFailed = $state(false);
// Open-PR count for each browsable repo, keyed by `owner/name`. Populated
// asynchronously after `fetchAvailableRepos` returns — the dialog renders
// the list immediately and fills in the hint subtext when this map updates.
let availablePrCounts = $state<Record<string, number>>({});
// Flag flipped once the PR-count fetch has resolved (success or failure) at
// least once. Lets the UI treat missing entries as "No open PRs" rather
// than holding a blank hint indefinitely when a repo errors out server-side.
let availablePrCountsLoaded = $state(false);
let selectedPrId = $state<string | null>(null);
let searchQuery = $state("");
let isLoading = $state(false);
let archivedPrs = $state<PullRequest[]>([]);
// Cursor for the next page of archived PRs. Null = exhausted or never
// fetched. Updated by `fetchArchivedPrs` (replaces the list, sets cursor
// from the first page) and `fetchMoreArchived` (appends, advances cursor).
let archivedNextCursor = $state<string | null>(null);
// True while a `fetchMoreArchived` request is in flight, so the sidebar
// can disable the "show more" affordance and show a spinner.
let archivedLoadingMore = $state(false);

// Sidebar PR search uses the same fuzzy scorer as the Cmd+P palette so a
// search like "auth jw" can match "Add JWT auth middleware" and a search like
// "feat/login" can match a branch even when it doesn't appear in the title.
// Fields scored: title, source branch, `#externalId`, author login, and the
// owner/name of the repo the PR lives in. The PR's best per-field score wins.
//
// Result ordering: when there's an active query we sort by score (descending)
// so the strongest matches surface first within each repo group; with no
// query we preserve the server-provided order.
let filteredPrs = $derived.by((): PullRequest[] => {
  const q = searchQuery.trim();
  if (q === "") return pullRequests;

  const repoMap = new Map(repositories.map((r) => [r.id, r]));

  return pullRequests
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

let groupedByRepo = $derived(Map.groupBy(filteredPrs, (pr) => pr.repositoryId));

// Repos visible in the sidebar after the active-org filter is applied. The
// underlying `repositories` array is left untouched so background sync,
// polling, and selection lookups continue to resolve every repo regardless
// of the org filter — only the rendered list narrows.
let visibleRepositories = $derived.by(() => {
  const owner = getActiveOrg();
  const ownerLower = owner?.toLowerCase();
  return repositories.filter((r) => {
    if (ownerLower && r.owner.toLowerCase() !== ownerLower) return false;
    return true;
  });
});

let needsYourReview = $derived(
  (() => {
    const login = getCurrentUserLogin();
    if (!login) return [] as PullRequest[];
    return filteredPrs.filter((pr) => pr.requestedReviewers.includes(login));
  })(),
);

let needsYourReviewByRepo = $derived(Map.groupBy(needsYourReview, (pr) => pr.repositoryId));

let archivedByRepo = $derived(Map.groupBy(archivedPrs, (pr) => pr.repositoryId));

let selectedPr = $derived(pullRequests.find((pr) => pr.id === selectedPrId) ?? null);

export function getGroupedByRepo(): Map<string, PullRequest[]> {
  return groupedByRepo;
}

export function getNeedsYourReview(): PullRequest[] {
  return needsYourReview;
}

export function getNeedsYourReviewByRepo(): Map<string, PullRequest[]> {
  return needsYourReviewByRepo;
}

/**
 * Open PRs for one repo with needs-your-review PRs sorted to the top.
 * Used by the per-repo PRs sub-section in the sidebar so the pinned rows
 * (with a visible marker) appear above the rest of the open PRs without
 * re-implementing the dedupe loop at every call site.
 */
export function getOpenPrsByRepoOrdered(repoId: string): PullRequest[] {
  const review = needsYourReviewByRepo.get(repoId) ?? [];
  const all = groupedByRepo.get(repoId) ?? [];
  if (review.length === 0) return all;
  const reviewIds = new Set(review.map((p) => p.id));
  const rest = all.filter((p) => !reviewIds.has(p.id));
  return [...review, ...rest];
}

export function getArchivedPrs(): PullRequest[] {
  return archivedPrs;
}

export function getArchivedByRepo(): Map<string, PullRequest[]> {
  return archivedByRepo;
}

export function getSelectedPr(): PullRequest | null {
  return selectedPr;
}

export function setPullRequests(prs: PullRequest[]): void {
  pullRequests = prs;
}

/**
 * Merge-patch the in-memory PR list from a WebSocket `prs:updated` event.
 * Updates existing PRs by id in place, appends genuinely new ones.
 * Preserves existing order and derived state.
 */
export function mergePullRequests(incoming: PullRequest[]): void {
  const map = new Map(pullRequests.map((pr) => [pr.id, pr]));
  for (const pr of incoming) {
    map.set(pr.id, pr);
  }
  const existingIds = new Set(pullRequests.map((pr) => pr.id));
  const merged: PullRequest[] = [];
  for (const pr of pullRequests) {
    const updated = map.get(pr.id);
    if (updated) merged.push(updated);
  }
  for (const pr of incoming) {
    if (!existingIds.has(pr.id)) merged.push(pr);
  }
  pullRequests = merged;
}

export function setRepositories(repos: Repository[]): void {
  repositories = repos;
}

export function updateRepoCloneStatus(repoId: string, status: CloneStatus, error?: string): void {
  repositories = repositories.map((r) =>
    r.id === repoId ? { ...r, cloneStatus: status, cloneError: error ?? r.cloneError } : r,
  );
}

export async function fetchThreadSummaries(prIds: string[]): Promise<void> {
  if (prIds.length === 0) return;
  try {
    const results = await Promise.allSettled(
      prIds.slice(0, 20).map(async (prId) => {
        const { data, error } = await api.api.prs({ id: prId })["thread-summary"].get();
        if (error || !data) return null;
        return { prId, summary: data as ThreadSummary };
      }),
    );
    const entries = results
      .filter(
        (r): r is PromiseFulfilledResult<{ prId: string; summary: ThreadSummary } | null> =>
          r.status === "fulfilled",
      )
      .map((r) => r.value)
      .filter((v): v is { prId: string; summary: ThreadSummary } => v !== null);
    setBatchSummaries(entries);
  } catch {
    // best-effort
  }
}

export async function fetchPrs(): Promise<void> {
  isLoading = true;
  try {
    const { data } = await api.api.prs.get();
    if (data) {
      pullRequests = data as PullRequest[];
      // Fire-and-forget: load thread summaries for all open PRs
      const openIds = (data as PullRequest[]).filter((p) => p.status === "open").map((p) => p.id);
      void fetchThreadSummaries(openIds);
      void fetchArchivedPrs();
    }
  } catch {
    // error handled by wsStore or caller
  } finally {
    isLoading = false;
  }
}

export async function fetchArchivedPrs(): Promise<void> {
  try {
    const { data } = await api.api.prs.archived.get({ query: {} });
    if (data) {
      const page = data as { prs: PullRequest[]; nextCursor: string | null };
      archivedPrs = page.prs;
      archivedNextCursor = page.nextCursor;
    }
  } catch {
    // best-effort
  }
}

/**
 * Fetch the next page of archived PRs using the cursor returned from the
 * prior request. Appends to `archivedPrs` rather than replacing — used by
 * the sidebar's "show more" affordance. No-op if there's no cursor
 * (already exhausted) or a fetch is already in flight.
 */
export async function fetchMoreArchived(): Promise<void> {
  if (archivedNextCursor === null) return;
  if (archivedLoadingMore) return;
  archivedLoadingMore = true;
  try {
    const { data } = await api.api.prs.archived.get({
      query: { cursor: archivedNextCursor },
    });
    if (data) {
      const page = data as { prs: PullRequest[]; nextCursor: string | null };
      // Deduplicate against existing rows in case a `pr:archived` patch
      // landed between request and response.
      const existingIds = new Set(archivedPrs.map((p) => p.id));
      const fresh = page.prs.filter((p) => !existingIds.has(p.id));
      archivedPrs = [...archivedPrs, ...fresh];
      archivedNextCursor = page.nextCursor;
    }
  } catch {
    // best-effort — leave cursor in place so the user can retry
  } finally {
    archivedLoadingMore = false;
  }
}

export function getArchivedNextCursor(): string | null {
  return archivedNextCursor;
}

export function getArchivedLoadingMore(): boolean {
  return archivedLoadingMore;
}

/**
 * Patch in-memory state in response to a `pr:archived` WS envelope.
 * Removes the PR from the open list, prepends it to the archive (newest
 * first), updates its status/closedAt fields if present. Best-effort: if
 * the PR isn't known locally, this is a no-op and the next `prs:updated`
 * shotgun will reconcile.
 */
export function onPrArchived(data: {
  prId: string;
  repoId: string;
  status: "closed" | "merged";
  closedAt: string;
}): void {
  // Already archived? Update in place and don't re-prepend.
  const archIdx = archivedPrs.findIndex((p) => p.id === data.prId);
  if (archIdx >= 0) {
    const existing = archivedPrs[archIdx];
    if (!existing) return;
    archivedPrs = [
      ...archivedPrs.slice(0, archIdx),
      { ...existing, status: data.status, closedAt: data.closedAt },
      ...archivedPrs.slice(archIdx + 1),
    ];
    pullRequests = pullRequests.filter((p) => p.id !== data.prId);
    return;
  }
  // Move from open list into archive.
  const openIdx = pullRequests.findIndex((p) => p.id === data.prId);
  if (openIdx >= 0) {
    const existing = pullRequests[openIdx];
    if (!existing) return;
    const archived = { ...existing, status: data.status, closedAt: data.closedAt };
    pullRequests = [...pullRequests.slice(0, openIdx), ...pullRequests.slice(openIdx + 1)];
    archivedPrs = [archived, ...archivedPrs];
  }
  // PR not known locally — wait for the `prs:updated` reconcile.
}

export async function fetchRepos(): Promise<void> {
  try {
    const { data } = await api.api.repos.get();
    if (data) repositories = data as Repository[];
  } catch {
    // error handled by caller
  }
}

export async function syncPrs(): Promise<void> {
  isLoading = true;
  try {
    await api.api.prs.sync.post();
  } catch {
    // errors arrive via WebSocket
  } finally {
    isLoading = false;
  }
}

export function setSelectedPrId(id: string | null): void {
  selectedPrId = id;
}

export async function selectPr(id: string): Promise<void> {
  selectedPrId = id;
  if (typeof window !== "undefined" && window.location.pathname === `/review/${id}`) return;
  await goto(`/review/${id}`);
}

export function setSearchQuery(q: string): void {
  searchQuery = q;
}

export async function addRepo(fullName: string): Promise<void> {
  const { error } = await api.api.repos.post({ fullName });
  if (error) {
    const value = error.value as { error?: string; message?: string } | undefined;
    const msg = value?.error ?? value?.message ?? `Failed to add repository (HTTP ${error.status})`;
    throw new Error(msg);
  }
  await fetchRepos();
  // Trigger a sync so PRs for the new repo are fetched immediately.
  // The server-side POST handler forks a background sync, but that fiber
  // may complete after the response returns.  An explicit sync here uses
  // the awaited POST /api/prs/sync endpoint, which guarantees the sync
  // finishes and broadcasts prs:updated over the WebSocket before
  // returning.  fetchPrs() is a safety net in case the WS message is
  // missed.
  await syncPrs();
  await fetchPrs();
}

export async function deleteRepo(id: string): Promise<void> {
  try {
    await api.api.repos({ id }).delete();
    await fetchRepos();
    await fetchPrs();
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to remove repository");
    throw e;
  }
}

/**
 * Owner-only PR mutations. The server runs the GitHub mutation, refreshes
 * the local row from a fresh GET, and broadcasts `prs:updated` — we only
 * surface the loading state and toast on failure here. The list refresh
 * arrives over the WebSocket; no local mutation is required.
 */
export async function convertPrToDraft(prId: string): Promise<void> {
  try {
    const { error } = await api.api.prs({ id: prId })["convert-to-draft"].post();
    if (error) throw new Error(`HTTP ${error.status}`);
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to convert to draft");
    throw e;
  }
}

export async function markPrReadyForReview(prId: string): Promise<void> {
  try {
    const { error } = await api.api.prs({ id: prId })["ready-for-review"].post();
    if (error) throw new Error(`HTTP ${error.status}`);
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to mark ready for review");
    throw e;
  }
}

export async function closePr(prId: string): Promise<void> {
  try {
    const { error } = await api.api.prs({ id: prId }).close.post();
    if (error) throw new Error(`HTTP ${error.status}`);
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to close PR");
    throw e;
  }
}

export async function retryClone(id: string): Promise<void> {
  // Optimistic flip so the spinner appears immediately. The server's
  // background fiber will broadcast 'cloning' then 'ready'/'error' via the
  // `repos:clone-status` WS message, which `ws.svelte.ts` routes through
  // `updateRepoCloneStatus`. If the POST itself fails, we surface the error
  // state here so the indicator stays actionable.
  updateRepoCloneStatus(id, "pending", "");
  try {
    await api.api.repos({ id })["retry-clone"].post();
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to retry clone";
    updateRepoCloneStatus(id, "error", msg);
    toast.error(msg);
    throw e;
  }
}

export function getPullRequests(): PullRequest[] {
  return pullRequests;
}

export function getRepositories(): Repository[] {
  return repositories;
}

export function getVisibleRepositories(): Repository[] {
  return visibleRepositories;
}

export function getSelectedPrId(): string | null {
  return selectedPrId;
}

export function getSearchQuery(): string {
  return searchQuery;
}

export function getIsLoading(): boolean {
  return isLoading;
}

export async function fetchAvailableRepos(force = false): Promise<void> {
  availableReposLoading = true;
  if (force) availableReposFetchFailed = false;
  try {
    const { data, error } = await api.api.github.repos.get({
      query: { force: force ? "true" : undefined },
    });
    if (error) {
      availableReposFetchFailed = true;
      return;
    }
    if (data) {
      availableRepos = data as Repository[];
      availableReposFetchFailed = false;
      // Fire-and-forget — the row hint renders as the counts arrive.
      void fetchAvailablePrCounts(availableRepos.map((r) => r.fullName));
    }
  } catch {
    availableReposFetchFailed = true;
  } finally {
    availableReposLoading = false;
  }
}

async function fetchAvailablePrCounts(fullNames: string[]): Promise<void> {
  if (fullNames.length === 0) {
    availablePrCountsLoaded = true;
    return;
  }
  try {
    const { data, error } = await api.api.github["pr-counts"].post({ fullNames });
    if (error || !data) return;
    availablePrCounts = {
      ...availablePrCounts,
      ...(data as { counts: Record<string, number> }).counts,
    };
  } catch {
    // Silent — hint is best-effort, list still works without counts.
  } finally {
    availablePrCountsLoaded = true;
  }
}

export function getAvailableRepos(): Repository[] {
  return availableRepos;
}

export function getAvailableReposLoading(): boolean {
  return availableReposLoading;
}

export function getAvailableReposFetchFailed(): boolean {
  return availableReposFetchFailed;
}

export function getAvailablePrCount(fullName: string): number | undefined {
  return availablePrCounts[fullName];
}

export function getAvailablePrCountsLoaded(): boolean {
  return availablePrCountsLoaded;
}

export function reset(): void {
  pullRequests = [];
  repositories = [];
  availableRepos = [];
  availableReposLoading = false;
  availableReposFetchFailed = false;
  availablePrCounts = {};
  availablePrCountsLoaded = false;
  selectedPrId = null;
  searchQuery = "";
  isLoading = false;
  archivedPrs = [];
  archivedNextCursor = null;
  archivedLoadingMore = false;
}
