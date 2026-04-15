<script lang="ts">
	import { page } from '$app/state';
	import { getSelectedPr, setSelectedPrId } from '$lib/stores/prs.svelte';
	import {
		setActiveFilePath,
		clearExplanations,
		getReviewFiles,
		getIsLoadingFiles,
		getFilesError,
		setReviewFiles,
		setIsLoadingFiles,
		setFilesError,
		clearReviewFiles,
		loadSession,
	} from '$lib/stores/review.svelte';
	import { getDiffThemeType } from '$lib/stores/theme.svelte';
	import { api } from '$lib/api/client';
	import ReviewLayout from '$lib/components/review/ReviewLayout.svelte';
	import { onDestroy } from 'svelte';

	const pr = $derived(getSelectedPr());
	const themeType = $derived(getDiffThemeType());
	const files = $derived(getReviewFiles());
	const isLoading = $derived(getIsLoadingFiles());
	const loadError = $derived(getFilesError());

	let currentRequestId = 0;

	$effect(() => {
		const prId = page.params['prId'];
		if (!prId) return;

		// Bump request ID so any in-flight fetch for a previous PR is ignored
		const requestId = ++currentRequestId;

		setSelectedPrId(prId);
		clearExplanations();
		clearReviewFiles();
		setIsLoadingFiles(true);

		(async () => {
			try {
				// Fetch files and session in parallel — session failure shouldn't block diff
				const [filesResult] = await Promise.all([
					api.api.prs({ id: prId }).files.get(),
					loadSession(prId).catch((e) =>
						console.error('[review] Session load failed (non-blocking):', e)
					),
				]);

				if (requestId !== currentRequestId) return;

				const { data, error } = filesResult;
				if (error) throw new Error('Failed to fetch PR files');
				if (Array.isArray(data)) {
					const mapped = data.map((f) => ({
						path: f.path,
						patch: f.patch ?? null,
						additions: f.additions,
						deletions: f.deletions,
						...(f.oldPath ? { oldPath: f.oldPath } : {}),
						...(f.isNew ? { isNew: true as const } : {}),
						...(f.isDeleted ? { isDeleted: true as const } : {}),
					}));
					setReviewFiles(mapped);
					if (mapped.length > 0) {
						setActiveFilePath(mapped[0]!.path);
					}
				}
			} catch (e) {
				if (requestId !== currentRequestId) return;
				setFilesError(e instanceof Error ? e.message : 'Failed to load diff');
			} finally {
				if (requestId === currentRequestId) setIsLoadingFiles(false);
			}
		})();
	});

	onDestroy(() => {
		// Invalidate any in-flight request and clean up store state
		currentRequestId++;
		clearReviewFiles();
	});
</script>

{#if isLoading}
	<div class="loading">
		<p>Loading diff…</p>
	</div>
{:else if loadError}
	<div class="loading error">
		<p>{loadError}</p>
	</div>
{:else if pr !== null && files.length > 0}
	<ReviewLayout prId={page.params['prId'] ?? ''} {files} {themeType} />
{:else if pr !== null}
	<div class="loading">
		<p>No changed files in this PR</p>
	</div>
{:else}
	<div class="loading">
		<p>Loading…</p>
	</div>
{/if}

<style>
	.loading {
		display: flex;
		height: 100%;
		align-items: center;
		justify-content: center;
		font-size: 13px;
		color: var(--color-text-muted);
	}

	.error {
		color: var(--color-danger, #ef4444);
	}
</style>
