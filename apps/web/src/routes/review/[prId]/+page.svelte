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
	getActiveTab,
	switchPrViewState,
} from '$lib/stores/review.svelte';
	import { getDiffThemeType } from '$lib/stores/theme.svelte';
	import { api } from '$lib/api/client';
	import ReviewLayout from '$lib/components/review/ReviewLayout.svelte';
	import GuidedWalkthrough from '$lib/components/walkthrough/GuidedWalkthrough.svelte';
	import RequestChanges from '$lib/components/review/RequestChanges.svelte';
	import { deactivate as deactivateWalkthrough, getIsStreaming as getWalkthroughStreaming, getSummary as getWalkthroughSummary, regenerate as regenerateWalkthrough, abort as abortWalkthrough, getIssues as getWalkthroughIssues, getRiskLevel as getWalkthroughRiskLevel } from '$lib/stores/walkthrough.svelte';
	import { setTopbarCollapsed } from '$lib/stores/topbar.svelte';
	import { getSidebarCollapsed, getSidebarWidth } from '$lib/stores/sidebar.svelte';
	import { requestThreadSync } from '$lib/stores/ws.svelte';
	import { onDestroy, untrack } from 'svelte';
	import AuthGuard from '$lib/components/auth/AuthGuard.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import { Tooltip, TooltipContent, TooltipTrigger } from '$lib/components/ui/tooltip';
	import { RefreshCw, Square } from '@lucide/svelte';
	import RegenerateDialog from '$lib/components/walkthrough/RegenerateDialog.svelte';

	const pr = $derived(getSelectedPr());
	const themeType = $derived(getDiffThemeType());
	const files = $derived(getReviewFiles());
	const isLoading = $derived(getIsLoadingFiles());
	const loadError = $derived(getFilesError());
	const activeTab = $derived(getActiveTab());
	const walkthroughStreaming = $derived(getWalkthroughStreaming());
	const walkthroughSummary = $derived(getWalkthroughSummary());
	const walkthroughIssues = $derived(getWalkthroughIssues());
	const walkthroughRiskLevel = $derived(getWalkthroughRiskLevel());

	const sidebarCollapsed = $derived(getSidebarCollapsed());
	const sidebarWidth = $derived(getSidebarWidth());
	const sidebarOffset = $derived(sidebarCollapsed ? 0 : sidebarWidth / 2);

	const riskClasses: Record<string, string> = {
		low: 'risk-badge risk-badge--low',
		medium: 'risk-badge risk-badge--medium',
		high: 'risk-badge risk-badge--high',
	};

	// The title lives inside the scroll container and scrolls away naturally.
	// An IntersectionObserver on the title element drives the compact topbar.
	let scrollRootEl: HTMLDivElement | undefined = $state(undefined);
	let titleEl: HTMLDivElement | undefined = $state(undefined);

	// Diff tab has its own layout and no big title — always show the compact PR title in the topbar.
	const forceCompact = $derived(activeTab === 'diff');

	$effect(() => {
		if (forceCompact) {
			setTopbarCollapsed(true);
			return;
		}
		if (!titleEl || !scrollRootEl) {
			setTopbarCollapsed(false);
			return;
		}
		const target = titleEl;
		const io = new IntersectionObserver(
			([entry]) => {
				if (!entry) return;
				setTopbarCollapsed(!entry.isIntersecting);
			},
			{ root: scrollRootEl, threshold: 0 }
		);
		io.observe(target);
		return () => io.disconnect();
	});

	const tabScrollPositions = new Map<string, number>();
	let prevTab: string | undefined;

	// Save BEFORE the DOM update (while the container is still visible)
	$effect.pre(() => {
		const tab = activeTab;
		if (scrollRootEl && prevTab && prevTab !== 'diff') {
			tabScrollPositions.set(prevTab, scrollRootEl.scrollTop);
		}
		prevTab = tab;
	});

	// Restore AFTER the DOM update (container is now visible again)
	// Only fires when activeTab changes — not on every re-render
	let restoredForTab: string | null = null;
	$effect(() => {
		const tab = activeTab;
		if (!scrollRootEl || tab === 'diff') return;
		if (tab === restoredForTab) return;
		restoredForTab = tab;
		const saved = tabScrollPositions.get(tab) ?? 0;
		scrollRootEl.scrollTop = saved;
	});

	let currentRequestId = 0;

	// Phase 1 stopgap: avoid refetching diff files when the user bounces back to
	// the same PR within a minute. Replaced by queryStore in Phase 3.
	let lastLoadedPrId: string | null = null;
	let lastLoadedAt = 0;
	const PR_REFETCH_WINDOW_MS = 60_000;

	$effect(() => {
		const prId = page.params['prId'];
		if (!prId) return;

		// Everything below mutates store state. Calls like `clearReviewFiles()`
		// invoke `clearSession()`, which does `threadsVersion++` — a read-then-
		// write on $state. Inside an untracked block, that read doesn't subscribe
		// the effect to threadsVersion, so the write can't re-trigger us.
		untrack(() => {
			// Bump request ID so any in-flight fetch for a previous PR is ignored
			const requestId = ++currentRequestId;

			setSelectedPrId(prId);
			switchPrViewState(prId);
			requestThreadSync(prId);

			// Short-circuit: same PR, recent load, files still in memory —
			// keep rendering what's there. A WS `cache:invalidated` (Phase 3)
			// or a hard refresh will bust this.
			const now = Date.now();
			const currentFiles = getReviewFiles();
			if (
				prId === lastLoadedPrId &&
				now - lastLoadedAt < PR_REFETCH_WINDOW_MS &&
				currentFiles.length > 0
			) {
				// Still kick off a session load so thread-counts refresh; cheap.
				loadSession(prId).catch((e) =>
					console.error('[review] Session load failed (non-blocking):', e),
				);
				return;
			}

			clearExplanations();
			clearReviewFiles();
			setIsLoadingFiles(true);

			(async () => {
			try {
				// Fetch the PR's "Files changed" diff directly from GitHub via the
				// server. The diff is always baseSha...headSha (merge-base, 3-dot),
				// matching GitHub's "Files changed" tab. There is no per-commit
				// selection — the dropdown is read-only.
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
					lastLoadedPrId = prId;
					lastLoadedAt = Date.now();
				}
			} catch (e) {
				if (requestId !== currentRequestId) return;
				setFilesError(e instanceof Error ? e.message : 'Failed to load diff');
			} finally {
				if (requestId === currentRequestId) setIsLoadingFiles(false);
			}
		})();
		});
	});

	onDestroy(() => {
		// Invalidate any in-flight request and clean up store state
		currentRequestId++;
		clearReviewFiles();
		deactivateWalkthrough(); // Clear active view without aborting background generation
		setTopbarCollapsed(false);
	});

	let regenerateDialogOpen = $state(false);

	function handleRegenerate(): void {
		const prId = page.params['prId'] ?? '';
		if (walkthroughIssues.length > 0) {
			regenerateDialogOpen = true;
		} else {
			regenerateWalkthrough(prId);
		}
	}
</script>

<AuthGuard>
{#if isLoading}
	<div class="loading">
		<p>Loading diff…</p>
	</div>
{:else if loadError}
	<div class="loading error">
		<p>{loadError}</p>
	</div>
{:else if pr !== null}
	<div class="review-page">
		{#if activeTab === 'diff'}
			{#if files.length > 0}
				<ReviewLayout prId={page.params['prId'] ?? ''} {files} {themeType} />
			{:else}
				<div class="loading">
					<p>No changed files in this PR</p>
				</div>
			{/if}
		{/if}

		<!-- Scroll root for walkthrough and request-changes tabs. Kept mounted
		     across diff-tab switches so the walkthrough never unmounts. -->
		<div
			class="review-content"
			bind:this={scrollRootEl}
			style={activeTab === 'diff' ? 'display: none' : ''}
		>
			<div class="page-title-section" bind:this={titleEl}>
				<div class="title-row">
					<h1 class="page-title">{pr.title}</h1>
					{#if activeTab === 'walkthrough' && walkthroughStreaming}
						<Tooltip>
							<TooltipTrigger>
								{#snippet child({ props })}
									<Button
										{...props}
										variant="ghost"
										size="icon-sm"
										class="stop-generation"
										onclick={abortWalkthrough}
									>
										<Square size={14} fill="currentColor" />
									</Button>
								{/snippet}
							</TooltipTrigger>
							<TooltipContent>Stop generation</TooltipContent>
						</Tooltip>
					{:else if activeTab === 'walkthrough' && walkthroughSummary}
						<Tooltip>
							<TooltipTrigger>
								{#snippet child({ props })}
									<Button
										{...props}
										variant="ghost"
										size="icon-sm"
										onclick={handleRegenerate}
									>
										<RefreshCw size={14} />
									</Button>
								{/snippet}
							</TooltipTrigger>
							<TooltipContent>Regenerate walkthrough</TooltipContent>
						</Tooltip>
					{/if}
				</div>
				<span class="page-subtitle">#{pr.externalId} · {pr.sourceBranch} → {pr.targetBranch}</span>
			{#if activeTab === 'walkthrough' && walkthroughRiskLevel}
					<Badge variant="outline" class={riskClasses[walkthroughRiskLevel] ?? ''}>
						{walkthroughRiskLevel} risk
					</Badge>
				{/if}
			</div>

			<!-- Walkthrough: always mounted to avoid re-render freeze on tab switch.
			     Heavy blocks (PierreFile, FileDiff, markdown) stay alive in DOM. -->
			<div style={activeTab === 'walkthrough' ? 'display: contents' : 'display: none'}>
				<GuidedWalkthrough
					prId={page.params['prId'] ?? ''}
					scrollRoot={scrollRootEl}
					isActive={activeTab === 'walkthrough'}
					{sidebarOffset}
				/>
			</div>

			<div style={activeTab === 'request-changes' ? 'display: contents' : 'display: none'}>
				<RequestChanges prId={page.params['prId'] ?? ''} />
			</div>
		</div>
	</div>
{:else}
	<div class="loading">
		<p>Loading…</p>
	</div>
{/if}
</AuthGuard>

<RegenerateDialog
	bind:open={regenerateDialogOpen}
	issues={walkthroughIssues}
	onconfirm={(kept) => regenerateWalkthrough(page.params['prId'] ?? '', kept)}
	oncancel={() => {}}
/>

<style>
	.review-page {
		display: flex;
		flex-direction: column;
		height: 100%;
		overflow: hidden;
		position: relative;
	}

	/* ── Scroll container for walkthrough / request-changes ──────────── */

	.review-content {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
	}

	/* ── Title section (scrolls away naturally with content) ─────────── */

	.page-title-section {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 76px 32px 16px;
		flex-shrink: 0;
	}

	.title-row {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
	}

	.title-row :global(button) {
		flex-shrink: 0;
		opacity: 0.5;
		transition: opacity 150ms ease;
	}

	.title-row :global(button:hover) {
		opacity: 1;
	}

	.page-title {
		font-size: 32px;
		font-weight: 700;
		color: var(--color-text-primary);
		line-height: 1.2;
		letter-spacing: -0.02em;
		margin: 0;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		min-width: 0;
		flex: 1;
	}

	.page-subtitle {
		font-size: 13px;
		font-family: var(--font-mono, monospace);
		color: var(--color-text-muted);
		opacity: 0.5;
		line-height: 1.4;
	}

	/* ── Risk badge (walkthrough) ─────────────────────────────────────── */

	:global(.risk-badge) {
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		border-radius: 9999px;
		padding: 1px 6px;
		width: fit-content;
	}

	.loading {
		display: flex;
		height: 100%;
		align-items: center;
		justify-content: center;
		font-size: 13px;
		color: var(--color-text-muted);
	}

	.error {
		color: var(--color-danger);
	}

	:global(.stop-generation) {
		color: var(--color-danger) !important;
		opacity: 1 !important;
	}

	:global(.stop-generation:hover) {
		color: var(--color-danger) !important;
		opacity: 0.8 !important;
	}
</style>
