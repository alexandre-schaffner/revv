import type { PullRequest, Repository, CloneStatus, ThreadSummary } from '@revv/shared';
import { api } from '$lib/api/client';
import { goto } from '$app/navigation';
import { API_BASE_URL } from '@revv/shared';
import { setBatchSummaries } from '$lib/stores/sync.svelte';
import { toast } from '$lib/utils/toast';

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

let selectedPr = $derived(
	pullRequests.find((pr) => pr.id === selectedPrId) ?? null
);

export function getFilteredPrs(): PullRequest[] {
	return filteredPrs;
}

export function getGroupedByRepo(): Map<string, PullRequest[]> {
	return groupedByRepo;
}

export function getSelectedPr(): PullRequest | null {
	return selectedPr;
}

export function setPullRequests(prs: PullRequest[]): void {
	pullRequests = prs;
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
		const token = typeof localStorage !== 'undefined' ? localStorage.getItem('rev_session_token') : null;
		if (!token) return;
		const results = await Promise.allSettled(
			prIds.slice(0, 20).map(async (prId) => {
				const res = await fetch(`${API_BASE_URL}/api/prs/${encodeURIComponent(prId)}/thread-summary`, {
					headers: { Authorization: `Bearer ${token}` },
				});
				if (!res.ok) return null;
				const summary = await res.json() as ThreadSummary;
				return { prId, summary };
			})
		);
		const entries = results
			.filter((r): r is PromiseFulfilledResult<{ prId: string; summary: ThreadSummary } | null> => r.status === 'fulfilled')
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

export function setSelectedPrId(id: string): void {
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
