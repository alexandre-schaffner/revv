import type { PullRequest, Repository, CloneStatus, ThreadSummary } from '@revv/shared';
import { api } from '$lib/api/client';
import { goto } from '$app/navigation';
import { setBatchSummaries } from '$lib/stores/sync.svelte';
import { toast } from 'svelte-sonner';
import { getCurrentUserLogin } from '$lib/stores/auth.svelte';

let pullRequests = $state<PullRequest[]>([]);
let repositories = $state<Repository[]>([]);
let availableRepos = $state<Repository[]>([]);
let availableReposLoading = $state(false);
let selectedPrId = $state<string | null>(null);
let searchQuery = $state('');
let isLoading = $state(false);
let lastSynced = $state<Date | null>(null);

let filteredPrs = $derived(
	searchQuery.trim() === ''
		? pullRequests
		: pullRequests.filter((pr) =>
				pr.title.toLowerCase().includes(searchQuery.toLowerCase())
			)
);

let groupedByRepo = $derived(
	Map.groupBy(filteredPrs, (pr) => pr.repositoryId)
);

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

export function getPullRequests(): PullRequest[] {
	return pullRequests;
}

export function getRepositories(): Repository[] {
	return repositories;
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
