import type {
  CloneStatus,
  MergeEligibility,
  MergeMethod,
  PullRequest,
  Repository,
  Team,
  ThreadSummary,
} from "@revv/shared";
import { REVIEW_MODE, type ReviewMode } from "@revv/shared";
import { toast } from "svelte-sonner";
import { goto } from "$app/navigation";
import { api } from "$lib/api/client";
import { getCurrentUserLogin } from "$lib/stores/auth.svelte";

import { setBatchSummaries } from "$lib/stores/sync.svelte";
import { clearOwnerHueCache, preloadOwnerHues } from "$lib/utils/avatarPalette";
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
// The server's effective managed-clone base (`REVV_CLONE_DIR`). Fetched once
// from the server so the add-repo flow never hardcodes a default that could
// diverge from an operator's override. Null until fetched (or if the fetch
// failed) — callers then omit `basePath` and let the server apply its own.
let defaultCloneBaseDir = $state<string | null>(null);
let selectedPrId = $state<string | null>(null);
// URL-driven: set by the +layout effect that reads /repo/[repoId] (or
// derives from the active PR's repositoryId). Mirrors the selectedPrId
// pattern — no localStorage, the URL is canonical so deep-links and
// browser back/forward behave naturally.
let selectedRepoId = $state<string | null>(null);
let searchQuery = $state("");
let selectedAuthorLogins = $state<Set<string>>(new Set());
// GitHub teams per org login (lowercased key), used by the creator filter to
// offer "select everyone on team X" shortcuts. Populated lazily the first
// time the filter popover opens for a repo owned by that org. Absence of a
// key means "not fetched yet"; an empty array means "fetched, none visible"
// (org has no teams, or the token lacks `read:org`).
let teamsByOrg = $state<Map<string, Team[]>>(new Map());
let teamsLoadingByOrg = $state<Map<string, boolean>>(new Map());
let teamsFailedByOrg = $state<Map<string, boolean>>(new Map());
let isLoading = $state(false);
let archivedPrs = $state<PullRequest[]>([]);
// Cursor for the next page of archived PRs. Null = exhausted or never
// fetched. Updated by `fetchArchivedPrs` (replaces the list, sets cursor
// from the first page) and `fetchMoreArchived` (appends, advances cursor).
let archivedNextCursor = $state<string | null>(null);
// True while a `fetchMoreArchived` request is in flight, so the sidebar
// can disable the "show more" affordance and show a spinner.
let archivedLoadingMore = $state(false);
// Tagged PRs per repo (requested reviewer, @-mentioned, or authored by the
// current user). Populated by `fetchTaggedPrs` — used by the repo homepage.
let taggedPrsByRepo = $state<Map<string, PullRequest[]>>(new Map());
let taggedPrsLoadingByRepo = $state<Map<string, boolean>>(new Map());
// Set of PR ids pinned by the current user. Fetched once at login and
// kept in sync via local optimistic updates.
let pinnedPrIds = $state<Set<string>>(new Set());

interface RepoDeleteSnapshot {
  readonly repositories: Repository[];
  readonly pullRequests: PullRequest[];
  readonly archivedPrs: PullRequest[];
  readonly taggedPrsByRepo: Map<string, PullRequest[]>;
  readonly pinnedPrIds: Set<string>;
}

// Sidebar PR search uses the same fuzzy scorer as the Cmd+P palette so a
// search like "auth jw" can match "Add JWT auth middleware" and a search like
// "feat/login" can match a branch even when it doesn't appear in the title.
// Fields scored: title, source branch, `#externalId`, author login, and the
// owner/name of the repo the PR lives in. The PR's best per-field score wins.
//
// Result ordering: when there's an active query we sort by score (descending)
// so the strongest matches surface first within each repo group; with no
// query we preserve the server-provided order.
const authorFilteredPrs = $derived.by((): PullRequest[] => {
  if (selectedAuthorLogins.size === 0) return pullRequests;
  return pullRequests.filter((pr) => selectedAuthorLogins.has(pr.authorLogin));
});

const filteredPrs = $derived.by((): PullRequest[] => {
  const q = searchQuery.trim();
  if (q === "") return authorFilteredPrs;

  const repoMap = new Map(repositories.map((r) => [r.id, r]));

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

const needsYourReview = $derived(
  (() => {
    const login = getCurrentUserLogin();
    if (!login) return [] as PullRequest[];
    return filteredPrs.filter((pr) => pr.requestedReviewers.includes(login));
  })(),
);

const needsYourReviewByRepo = $derived(Map.groupBy(needsYourReview, (pr) => pr.repositoryId));

const archivedByRepo = $derived(Map.groupBy(archivedPrs, (pr) => pr.repositoryId));

const selectedPr = $derived(
  pullRequests.find((pr) => pr.id === selectedPrId) ??
    archivedPrs.find((pr) => pr.id === selectedPrId) ??
    null,
);

const selectedRepo = $derived(
  selectedRepoId ? (repositories.find((r) => r.id === selectedRepoId) ?? null) : null,
);

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

// Author options precomputed per repo. Rebuilt only when the open-PR list
// changes (i.e. on a sync / `prs:updated`), never when the filter popover
// opens — so clicking the filter is an O(1) lookup of an already-built,
// reference-stable array, even on repos with hundreds of contributors.
const authorOptionsByRepo = $derived.by((): Map<string, PrAuthorFilterOption[]> => {
  const byRepo = new Map<string, AuthorAccumulator>();
  for (const pr of pullRequests) {
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
  for (const pr of pullRequests) tallyAuthor(counts, pr);
  return toSortedOptions(counts);
});

/**
 * Author options for the raw open-PR list. This intentionally ignores search
 * and the current author filter so the user can recover from an over-narrow
 * view without clearing other controls first. Reads from the precomputed
 * per-repo cache above, so it does no work when the popover opens.
 */
export function getAuthorFilterOptions(repoId?: string): PrAuthorFilterOption[] {
  if (!repoId) return allAuthorOptions;
  return authorOptionsByRepo.get(repoId) ?? [];
}

export function getSelectedAuthorLogins(): Set<string> {
  return selectedAuthorLogins;
}

export function hasActivePrListFilter(): boolean {
  return searchQuery.trim() !== "" || selectedAuthorLogins.size > 0;
}

/**
 * Open PRs for one repo with pinned PRs sorted to the very top, then
 * needs-your-review PRs, then the rest.
 */
export function getOpenPrsByRepoOrdered(repoId: string): PullRequest[] {
  const all = groupedByRepo.get(repoId) ?? [];
  const pinned = all.filter((p) => pinnedPrIds.has(p.id));
  const review = (needsYourReviewByRepo.get(repoId) ?? []).filter((p) => !pinnedPrIds.has(p.id));
  const skipIds = new Set([...pinned.map((p) => p.id), ...review.map((p) => p.id)]);
  const rest = all.filter((p) => !skipIds.has(p.id));
  return [...pinned, ...review, ...rest];
}

export function getOpenPrCountByRepo(repoId: string): number {
  return pullRequests.filter((pr) => pr.repositoryId === repoId).length;
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

/**
 * The review lens for a PR, derived purely from identity: `"author"` when the
 * signed-in user is the PR author, otherwise `"reviewer"`. This is the single
 * source of truth — there is no manual override. (The server still stores an
 * author walkthrough and a reviewer walkthrough separately per head SHA; we
 * always request the one that matches the viewer's role.)
 */
export function getReviewModeForPr(prId: string): ReviewMode {
  const pr =
    pullRequests.find((p) => p.id === prId) ?? archivedPrs.find((p) => p.id === prId) ?? null;
  const login = getCurrentUserLogin();
  return pr?.authorLogin && login && pr.authorLogin === login
    ? REVIEW_MODE.author
    : REVIEW_MODE.reviewer;
}

export function getTaggedPrs(repoId: string): PullRequest[] {
  return taggedPrsByRepo.get(repoId) ?? [];
}

export function getTaggedPrsLoading(repoId: string): boolean {
  return taggedPrsLoadingByRepo.get(repoId) ?? false;
}

export async function fetchTaggedPrs(repoId: string): Promise<void> {
  if (taggedPrsLoadingByRepo.get(repoId)) return;
  taggedPrsLoadingByRepo = new Map(taggedPrsLoadingByRepo).set(repoId, true);
  try {
    const { data } = await api.api.prs.tagged.get({ query: { repo: repoId } });
    if (data) {
      taggedPrsByRepo = new Map(taggedPrsByRepo).set(repoId, data as PullRequest[]);
    }
  } catch {
    // best-effort
  } finally {
    taggedPrsLoadingByRepo = new Map(taggedPrsLoadingByRepo).set(repoId, false);
  }
}

/**
 * Apply the full open-PR state from a `prs:updated` SSE event.
 * The server sends the canonical DB list for the active account, so replacing
 * avoids stale closed/reopened rows and preserves server ordering.
 */
export function replacePullRequests(incoming: PullRequest[]): void {
  pullRequests = incoming;
  if (incoming.length === 0 || archivedPrs.length === 0) return;

  const openIds = new Set(incoming.map((pr) => pr.id));
  archivedPrs = archivedPrs.filter((pr) => !openIds.has(pr.id));
}

let repositoryLoadSeq = 0;

export async function setRepositories(repos: Repository[]): Promise<void> {
  const seq = ++repositoryLoadSeq;
  await preloadOwnerHues(repos);
  if (seq === repositoryLoadSeq) repositories = repos;
}

function snapshotRepoState(): RepoDeleteSnapshot {
  return {
    repositories,
    pullRequests,
    archivedPrs,
    taggedPrsByRepo,
    pinnedPrIds,
  };
}

function restoreRepoState(snapshot: RepoDeleteSnapshot): void {
  repositories = snapshot.repositories;
  void preloadOwnerHues(repositories);
  pullRequests = snapshot.pullRequests;
  archivedPrs = snapshot.archivedPrs;
  taggedPrsByRepo = snapshot.taggedPrsByRepo;
  pinnedPrIds = snapshot.pinnedPrIds;
}

function removeRepoLocally(repoId: string): void {
  const removedPrIds = new Set(
    [...pullRequests, ...archivedPrs].filter((pr) => pr.repositoryId === repoId).map((pr) => pr.id),
  );

  repositories = repositories.filter((repo) => repo.id !== repoId);
  pullRequests = pullRequests.filter((pr) => pr.repositoryId !== repoId);
  archivedPrs = archivedPrs.filter((pr) => pr.repositoryId !== repoId);

  const nextTagged = new Map(taggedPrsByRepo);
  nextTagged.delete(repoId);
  taggedPrsByRepo = nextTagged;

  if (removedPrIds.size > 0) {
    pinnedPrIds = new Set([...pinnedPrIds].filter((prId) => !removedPrIds.has(prId)));
  }
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

export function isPrPinned(prId: string): boolean {
  return pinnedPrIds.has(prId);
}

export async function fetchPinnedPrs(): Promise<void> {
  try {
    const { data } = await api.api.prs.pinned.get();
    if (Array.isArray(data)) {
      pinnedPrIds = new Set(data as string[]);
    }
  } catch {
    // best-effort
  }
}

export async function pinPr(prId: string): Promise<void> {
  if (pinnedPrIds.has(prId)) return;
  pinnedPrIds = new Set(pinnedPrIds).add(prId);
  try {
    await api.api.prs.pinned.post({ prId });
  } catch {
    // Rollback on failure
    const next = new Set(pinnedPrIds);
    next.delete(prId);
    pinnedPrIds = next;
  }
}

export async function unpinPr(prId: string): Promise<void> {
  if (!pinnedPrIds.has(prId)) return;
  const next = new Set(pinnedPrIds);
  next.delete(prId);
  pinnedPrIds = next;
  try {
    await api.api.prs.pinned({ prId }).delete();
  } catch {
    // Rollback on failure
    pinnedPrIds = new Set(pinnedPrIds).add(prId);
  }
}

/**
 * Patch in-memory state in response to a `pr:archived` SSE envelope.
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
    if (data) await setRepositories(data as Repository[]);
  } catch {
    // error handled by caller
  }
}

export async function syncPrs(): Promise<void> {
  isLoading = true;
  try {
    await api.api.prs.sync.post();
  } catch {
    // errors arrive via SSE
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

export function toggleAuthorFilter(login: string): void {
  const next = new Set(selectedAuthorLogins);
  if (next.has(login)) next.delete(login);
  else next.add(login);
  selectedAuthorLogins = next;
}

/**
 * Add or remove a batch of author logins from the filter in one update.
 * Used by the team shortcuts: selecting a team adds all its members,
 * deselecting removes them. Reuses the same `selectedAuthorLogins` set the
 * per-creator toggles drive, so the downstream filter logic is unchanged.
 */
export function setAuthorFilters(logins: readonly string[], selected: boolean): void {
  if (logins.length === 0) return;
  const next = new Set(selectedAuthorLogins);
  for (const login of logins) {
    if (selected) next.add(login);
    else next.delete(login);
  }
  selectedAuthorLogins = next;
}

export function clearAuthorFilters(): void {
  if (selectedAuthorLogins.size === 0) return;
  selectedAuthorLogins = new Set();
}

export function getTeamsForOrg(owner: string): Team[] {
  return teamsByOrg.get(owner.toLowerCase()) ?? [];
}

export function getTeamsFetchStateForOrg(owner: string): "idle" | "loading" | "loaded" | "error" {
  const key = owner.toLowerCase();
  if (teamsLoadingByOrg.get(key)) return "loading";
  if (teamsFailedByOrg.get(key)) return "error";
  if (teamsByOrg.has(key)) return "loaded";
  return "idle";
}

/**
 * Lazily fetch an org's teams (and members) the first time they're needed.
 * Idempotent: no-ops once a result is cached or a request is already in
 * flight. Best-effort — failures leave the entry uncached so a later popover
 * open can retry instead of pinning a transient error as "no teams".
 */
export async function fetchTeamsForOrg(
  owner: string,
  options?: { force?: boolean },
): Promise<void> {
  const key = owner.toLowerCase();
  if (!options?.force && (teamsByOrg.has(key) || teamsLoadingByOrg.get(key))) return;
  if (options?.force) {
    const nextTeams = new Map(teamsByOrg);
    nextTeams.delete(key);
    teamsByOrg = nextTeams;
  }
  teamsLoadingByOrg = new Map(teamsLoadingByOrg).set(key, true);
  teamsFailedByOrg = new Map(teamsFailedByOrg).set(key, false);
  try {
    const { data, error } = await api.api.github.teams({ org: owner }).get();
    if (error) {
      teamsFailedByOrg = new Map(teamsFailedByOrg).set(key, true);
      return;
    }
    // Cache successful results — including an empty list — so reopening the
    // popover never re-hits the network when GitHub answered cleanly.
    teamsByOrg = new Map(teamsByOrg).set(key, (data as { teams: Team[] } | null)?.teams ?? []);
  } catch {
    // Leave the entry uncached. The popover remains usable with creator rows,
    // and a later open can retry without requiring account reset/re-login.
    teamsFailedByOrg = new Map(teamsFailedByOrg).set(key, true);
  } finally {
    teamsLoadingByOrg = new Map(teamsLoadingByOrg).set(key, false);
  }
}

export type AddRepoBody =
  | { readonly fullName: string; readonly mode?: "clone"; readonly basePath?: string }
  | { readonly fullName: string; readonly mode: "link"; readonly clonePath: string };

/** A bare `owner/name` string is sugar for `{ fullName, mode: "clone" }`. */
export type AddRepoInput = string | AddRepoBody;

function toAddRepoBody(input: AddRepoInput): AddRepoBody {
  if (typeof input === "string") return { fullName: input };
  return input;
}

export async function addRepo(input: AddRepoInput): Promise<void> {
  const { error } = await api.api.repos.post(toAddRepoBody(input));
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
  // finishes and broadcasts prs:updated over the SSE stream before
  // returning.  fetchPrs() is a safety net in case the SSE message is
  // missed.
  await syncPrs();
  await fetchPrs();
}

export function deleteRepo(id: string): Promise<void> {
  const snapshot = snapshotRepoState();
  const repo = repositories.find((r) => r.id === id);
  const toastOptions = repo ? { description: repo.fullName } : undefined;
  const toastId = toast.loading("Removing repository...", toastOptions);

  removeRepoLocally(id);

  void api.api
    .repos({ id })
    .delete()
    .then(({ error }) => {
      toast.dismiss(toastId);
      if (error) {
        restoreRepoState(snapshot);
        const value = error.value as { error?: string; message?: string } | undefined;
        toast.error(
          value?.error ?? value?.message ?? `Failed to remove repository (HTTP ${error.status})`,
        );
        return;
      }

      toast.success("Repository removed", toastOptions);
      void Promise.all([fetchRepos(), fetchPrs()]);
    })
    .catch((e) => {
      toast.dismiss(toastId);
      restoreRepoState(snapshot);
      toast.error(e instanceof Error ? e.message : "Failed to remove repository");
    });

  return Promise.resolve();
}

/**
 * Owner-only PR mutations. Optimistic with entity-scoped rollback per
 * conventions §4.6: flip the affected fields locally before awaiting the
 * server, restore them on throw. The successful round-trip's `prs:updated`
 * broadcast reconciles the canonical list as the source of truth — our
 * optimistic write is only for the in-flight window.
 */
function flipPrDraftLocally(prId: string, isDraft: boolean): void {
  pullRequests = pullRequests.map((p) => (p.id === prId ? { ...p, isDraft } : p));
}

export async function convertPrToDraft(prId: string): Promise<void> {
  const pr = pullRequests.find((p) => p.id === prId);
  if (!pr || pr.isDraft) return;
  const prevIsDraft = pr.isDraft;

  flipPrDraftLocally(prId, true);

  try {
    const { error } = await api.api.prs({ id: prId })["convert-to-draft"].post();
    if (error) throw new Error(`HTTP ${error.status}`);
  } catch (e) {
    flipPrDraftLocally(prId, prevIsDraft);
    toast.error(e instanceof Error ? e.message : "Failed to convert to draft");
    throw e;
  }
}

export async function markPrReadyForReview(prId: string): Promise<void> {
  const pr = pullRequests.find((p) => p.id === prId);
  if (!pr?.isDraft) return;
  const prevIsDraft = pr.isDraft;

  flipPrDraftLocally(prId, false);

  try {
    const { error } = await api.api.prs({ id: prId })["ready-for-review"].post();
    if (error) throw new Error(`HTTP ${error.status}`);
  } catch (e) {
    flipPrDraftLocally(prId, prevIsDraft);
    toast.error(e instanceof Error ? e.message : "Failed to mark ready for review");
    throw e;
  }
}

/**
 * Restore a PR from the archive back into the open list with prior status
 * and closedAt. Used by the `closePr` / `mergePr` rollback path — the
 * reverse of `onPrArchived`'s forward move. Touches only the one PR so
 * concurrent `prs:updated` reshuffles of other entries are preserved.
 */
function restorePrFromArchive(
  prId: string,
  prevStatus: PullRequest["status"],
  prevClosedAt: string | null,
): void {
  const archived = archivedPrs.find((p) => p.id === prId);
  if (!archived) return;
  archivedPrs = archivedPrs.filter((p) => p.id !== prId);
  pullRequests = [{ ...archived, status: prevStatus, closedAt: prevClosedAt }, ...pullRequests];
}

export async function closePr(prId: string): Promise<void> {
  const pr = pullRequests.find((p) => p.id === prId);
  if (!pr) {
    // PR not known locally — fall back to pessimistic. SSE reconciles.
    const { error } = await api.api.prs({ id: prId }).close.post();
    if (error) {
      toast.error(`Failed to close PR (HTTP ${error.status})`);
      throw new Error(`HTTP ${error.status}`);
    }
    return;
  }

  const prevStatus = pr.status;
  const prevClosedAt = pr.closedAt;

  onPrArchived({
    prId,
    repoId: pr.repositoryId,
    status: "closed",
    closedAt: new Date().toISOString(),
  });

  try {
    const { error } = await api.api.prs({ id: prId }).close.post();
    if (error) throw new Error(`HTTP ${error.status}`);
  } catch (e) {
    restorePrFromArchive(prId, prevStatus, prevClosedAt);
    toast.error(e instanceof Error ? e.message : "Failed to close PR");
    throw e;
  }
}

export async function getMergeEligibility(prId: string): Promise<MergeEligibility | null> {
  try {
    const { data, error } = await api.api.prs({ id: prId })["merge-eligibility"].get();
    if (error || !data) return null;
    return data as MergeEligibility;
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to check merge eligibility");
    return null;
  }
}

export async function mergePr(prId: string, mergeMethod: MergeMethod): Promise<void> {
  const pr = pullRequests.find((p) => p.id === prId);
  if (!pr) {
    // PR not known locally — fall back to pessimistic. SSE reconciles.
    const { error } = await api.api.prs({ id: prId }).merge.post({ mergeMethod });
    if (error) {
      toast.error(`Failed to merge pull request (HTTP ${error.status})`);
      throw new Error(`HTTP ${error.status}`);
    }
    toast.success("Pull request merged successfully");
    return;
  }

  const prevStatus = pr.status;
  const prevClosedAt = pr.closedAt;

  onPrArchived({
    prId,
    repoId: pr.repositoryId,
    status: "merged",
    closedAt: new Date().toISOString(),
  });

  try {
    const { error } = await api.api.prs({ id: prId }).merge.post({ mergeMethod });
    if (error) throw new Error(`HTTP ${error.status}`);
    toast.success("Pull request merged successfully");
  } catch (e) {
    restorePrFromArchive(prId, prevStatus, prevClosedAt);
    toast.error(e instanceof Error ? e.message : "Failed to merge pull request");
    throw e;
  }
}

export async function retryClone(id: string): Promise<void> {
  // Optimistic flip so the spinner appears immediately. The server's
  // background fiber will broadcast 'cloning' then 'ready'/'error' via the
  // `repos:clone-status` SSE message, which `events.svelte.ts` routes through
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

export function getRepoOwner(repoId: string): string | null {
  return repositories.find((r) => r.id === repoId)?.owner ?? null;
}

export function getSelectedPrId(): string | null {
  return selectedPrId;
}

export function getSelectedRepoId(): string | null {
  return selectedRepoId;
}

export function getSelectedRepo(): Repository | null {
  return selectedRepo;
}

export function setSelectedRepoId(id: string | null): void {
  selectedRepoId = id;
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
      const repos = data as Repository[];
      await preloadOwnerHues(repos);
      availableRepos = repos;
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

/**
 * Fetch the server's default clone base directory once and cache it. Idempotent
 * — subsequent calls no-op once a value is cached. Best-effort: on failure the
 * value stays null and the add-repo form omits `basePath`, deferring to the
 * server's own default.
 */
export async function fetchDefaultCloneBaseDir(): Promise<void> {
  if (defaultCloneBaseDir !== null) return;
  try {
    const { data, error } = await api.api.repos["clone-base-dir"].get();
    if (error || !data) return;
    defaultCloneBaseDir = (data as { path: string }).path;
  } catch {
    // Best-effort — see the field doc.
  }
}

export function getDefaultCloneBaseDir(): string | null {
  return defaultCloneBaseDir;
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
  repositoryLoadSeq++;
  clearOwnerHueCache();
  pullRequests = [];
  repositories = [];
  availableRepos = [];
  availableReposLoading = false;
  availableReposFetchFailed = false;
  availablePrCounts = {};
  availablePrCountsLoaded = false;
  selectedPrId = null;
  selectedRepoId = null;
  searchQuery = "";
  selectedAuthorLogins = new Set();
  teamsByOrg = new Map();
  teamsLoadingByOrg = new Map();
  teamsFailedByOrg = new Map();
  isLoading = false;
  archivedPrs = [];
  archivedNextCursor = null;
  archivedLoadingMore = false;
  pinnedPrIds = new Set();
}
