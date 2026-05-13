import type { PullRequest, Repository, CloneStatus, ThreadSummary } from '@revv/shared';
import { api } from '$lib/api/client';
import { goto } from '$app/navigation';
import { setBatchSummaries } from '$lib/stores/sync.svelte';
import { toast } from 'svelte-sonner';
import { getCurrentUserLogin } from '$lib/stores/auth.svelte';
import { getActiveOrg } from '$lib/stores/orgs.svelte';
import { fuzzyScore } from '$lib/utils/fuzzy';

let pullRequests = $state<PullRequest[]>([]);
let repositories = $state<Repository[]>([]);
let availableRepos = $state<Repository[]>([]);
let availableReposLoading = $state(false);
let selectedPrId = $state<string | null>(null);
let searchQuery = $state('');
let isLoading = $state(false);
let lastSynced = $state<Date | null>(null);

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
	if (q === '') return pullRequests;

	const repoMap = new Map(repositories.map((r) => [r.id, r]));

	return pullRequests
		.map((pr) => {
			const repoName = repoMap.get(pr.repositoryId)?.fullName ?? '';
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

let groupedByRepo = $derived(
	Map.groupBy(filteredPrs, (pr) => pr.repositoryId)
);

// Repos visible in the sidebar after the active-org filter is applied. The
// underlying `repositories` array is left untouched so background sync,
// polling, and selection lookups continue to resolve every repo regardless
// of the org filter — only the rendered list narrows.
let visibleRepositories = $derived.by(() => {
	const owner = getActiveOrg();
	return owner ? repositories.filter((r) => r.owner === owner) : repositories;
});

let needsYourReview = $derived(
	(() => {
		const login = getCurrentUserLogin();
		if (!login) return [] as PullRequest[];
		return filteredPrs.filter((pr) => pr.requestedReviewers.includes(login));
	})()
);

let needsYourReviewByRepo = $derived(
	Map.groupBy(needsYourReview, (pr) => pr.repositoryId)
);

let selectedPr = $derived(
	pullRequests.find((pr) => pr.id === selectedPrId) ?? null
);

export function getFilteredPrs(): PullRequest[] {
	return filteredPrs;
}

export function getGroupedByRepo(): Map<string, PullRequest[]> {
	return groupedByRepo;
}

export function getNeedsYourReview(): PullRequest[] {
	return needsYourReview;
}

export function getNeedsYourReviewByRepo(): Map<string, PullRequest[]> {
	return needsYourReviewByRepo;
}

export function getSelectedPr(): PullRequest | null {
	return selectedPr;
}

export function setPullRequests(prs: PullRequest[]): void {
	pullRequests = prs;
	lastSynced = new Date();
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
	lastSynced = new Date();
}

export function setRepositories(repos: Repository[]): void {
	repositories = repos;
}

export function updateRepoCloneStatus(repoId: string, status: CloneStatus, error?: string): void {
	repositories = repositories.map((r) =>
		r.id === repoId
			? { ...r, cloneStatus: status, cloneError: error ?? r.cloneError }
			: r
	);
}

export async function fetchThreadSummaries(prIds: string[]): Promise<void> {
	if (prIds.length === 0) return;
	try {
		const results = await Promise.allSettled(
			prIds.slice(0, 20).map(async (prId) => {
				const { data, error } = await api.api
					.prs({ id: prId })
					['thread-summary'].get();
				if (error || !data) return null;
				return { prId, summary: data as ThreadSummary };
			}),
		);
		const entries = results
			.filter(
				(r): r is PromiseFulfilledResult<{ prId: string; summary: ThreadSummary } | null> =>
					r.status === 'fulfilled',
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
			const openIds = (data as PullRequest[]).filter((p) => p.status === 'open').map((p) => p.id);
			void fetchThreadSummaries(openIds);
		}
	} catch {
		// error handled by wsStore or caller
	} finally {
		isLoading = false;
	}
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
	if (typeof window !== 'undefined' && window.location.pathname === `/review/${id}`) return;
	await goto(`/review/${id}`);
}

export function setSearchQuery(q: string): void {
	searchQuery = q;
}

export async function addRepo(fullName: string): Promise<void> {
	await api.api.repos.post({ fullName });
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
		toast.error(e instanceof Error ? e.message : 'Failed to remove repository');
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
		const { error } = await api.api.prs({ id: prId })['convert-to-draft'].post();
		if (error) throw new Error(`HTTP ${error.status}`);
	} catch (e) {
		toast.error(e instanceof Error ? e.message : 'Failed to convert to draft');
		throw e;
	}
}

export async function markPrReadyForReview(prId: string): Promise<void> {
	try {
		const { error } = await api.api.prs({ id: prId })['ready-for-review'].post();
		if (error) throw new Error(`HTTP ${error.status}`);
	} catch (e) {
		toast.error(e instanceof Error ? e.message : 'Failed to mark ready for review');
		throw e;
	}
}

export async function closePr(prId: string): Promise<void> {
	try {
		const { error } = await api.api.prs({ id: prId }).close.post();
		if (error) throw new Error(`HTTP ${error.status}`);
	} catch (e) {
		toast.error(e instanceof Error ? e.message : 'Failed to close PR');
		throw e;
	}
}

export async function retryClone(id: string): Promise<void> {
	// Optimistic flip so the spinner appears immediately. The server's
	// background fiber will broadcast 'cloning' then 'ready'/'error' via the
	// `repos:clone-status` WS message, which `ws.svelte.ts` routes through
	// `updateRepoCloneStatus`. If the POST itself fails, we surface the error
	// state here so the indicator stays actionable.
	updateRepoCloneStatus(id, 'pending', '');
	try {
		await api.api.repos({ id })['retry-clone'].post();
	} catch (e) {
		const msg = e instanceof Error ? e.message : 'Failed to retry clone';
		updateRepoCloneStatus(id, 'error', msg);
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

export function getLastSynced(): Date | null {
	return lastSynced;
}

export async function fetchAvailableRepos(force = false): Promise<void> {
	availableReposLoading = true;
	try {
		const { data } = await api.api.github.repos.get({ query: { force: force ? 'true' : undefined } });
		if (data) availableRepos = data as Repository[];
	} catch {
		// error handled by caller
	} finally {
		availableReposLoading = false;
	}
}

export function getAvailableRepos(): Repository[] {
	return availableRepos;
}

export function getAvailableReposLoading(): boolean {
	return availableReposLoading;
}

export function reset(): void {
	pullRequests = [];
	repositories = [];
	availableRepos = [];
	availableReposLoading = false;
	selectedPrId = null;
	searchQuery = '';
	isLoading = false;
	lastSynced = null;
}
