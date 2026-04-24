<script lang="ts">
	import { onMount, onDestroy, untrack } from 'svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Separator } from '$lib/components/ui/separator';
	import { RefreshCw, ArrowDown, FileText, CheckCircle, AlertTriangle, AlertCircle, Circle, Loader2, Sparkles } from '@lucide/svelte';
	import { getDiffThemeType } from '$lib/stores/theme.svelte';
	import { initHighlighter } from '$lib/utils/code-highlight.svelte';
	import { renderMarkdown } from '$lib/utils/markdown';
	import {
		getBlocks,
		getSummary,
		getRiskLevel,
		getIsStreaming,
		getStreamError,
		getExplorationSteps,
		getPhase,
		getPhaseMessage,
		getStreamStartedAt,
		getIssues,
		getRatings,
	getSentiment,
	getLastCompletedPhase,
	getIsSuperseded,
	getIsLiveGeneration,
	getCloneInProgress,
	getCloneRepoId,
	hasBlockAnimated,
	markBlockAnimated,
	hasIssueAnimated,
	markIssueAnimated,
	hasContainerAnimated,
	markContainerAnimated,
	prepareEntry,
	streamWalkthrough,
	hydrateFromCache,
	regenerate,
	pollCloneUntilResolved,
	stopClonePoll,
} from '$lib/stores/walkthrough.svelte';
	import { getRepositories } from '$lib/stores/prs.svelte';
	import { API_BASE_URL } from '@revv/shared';
	import { authHeaders } from '$lib/utils/session-token';
	import { Progress } from '$lib/components/ui/progress';
	import {
		jumpToDiffLine,
		getPendingWalkthroughBlockJump,
		clearPendingWalkthroughBlockJump,
	} from '$lib/stores/review.svelte';
	import { Skeleton } from '$lib/components/ui/skeleton/index.js';
	import { groupIssuesBySeverityWithIndex } from '$lib/utils/walkthrough-issues';

	import FileBadge from '$lib/components/ui/FileBadge.svelte';
	import IssueCard from './IssueCard.svelte';
	import WalkthroughMarkdownBlock from './WalkthroughMarkdownBlock.svelte';
	import WalkthroughCodeBlock from './WalkthroughCodeBlock.svelte';
	import WalkthroughDiffBlock from './WalkthroughDiffBlock.svelte';
	import WalkthroughRatingsGrid from './WalkthroughRatingsGrid.svelte';

	interface Props {
		prId: string;
		scrollRoot?: HTMLElement | undefined;
		isActive?: boolean;
	}

	let { prId, scrollRoot, isActive = true }: Props = $props();

	const blocks = $derived(getBlocks());
	const summary = $derived(getSummary());
	const riskLevel = $derived(getRiskLevel());
	const isStreaming = $derived(getIsStreaming());
	const streamError = $derived(getStreamError());
	const explorationSteps = $derived(getExplorationSteps());
	const phase = $derived(getPhase());
	const phaseMessage = $derived(getPhaseMessage());
	const streamStartedAt = $derived(getStreamStartedAt());
	const themeType = $derived(getDiffThemeType());
	const issues = $derived(getIssues());
	const issueGroups = $derived(groupIssuesBySeverityWithIndex(issues));
	// Summary is markdown — inline code (`foo`), bold (**foo**), and code fences
	// all appear in real walkthroughs. Rendering `{summary}` as plain text (the
	// old behavior) leaked backticks and asterisks into the DOM; render to HTML
	// and inject via {@html} so it reads like the rest of the walkthrough.
	const renderedSummary = $derived(summary ? renderMarkdown(summary) : '');
	const ratings = $derived(getRatings());
	const isLiveGeneration = $derived(getIsLiveGeneration());
	const cloneInProgress = $derived(getCloneInProgress());
	const cloneRepoId = $derived(getCloneRepoId());
	const repositories = $derived(getRepositories());
	// Phase C markdown — rendered inline as its own sentiment card when set.
	// Replaces the legacy heuristic of sniffing markdown blocks for a `##
	// Overall Sentiment` heading.
	const sentiment = $derived(getSentiment());
	const renderedSentiment = $derived(sentiment ? renderMarkdown(sentiment) : '');
	// Pointer into the A→B→C→D pipeline — drives the 4-dot header indicator.
	const lastCompletedPhase = $derived(getLastCompletedPhase());
	// Newer commit invalidated this walkthrough mid-render — show a banner.
	const superseded = $derived(getIsSuperseded());

	// ── Elapsed time ────────────────────────────────────────────────────
	let elapsedSeconds = $state(0);
	let elapsedTimer: ReturnType<typeof setInterval> | null = null;
	let walkthroughDebounce: ReturnType<typeof setTimeout> | undefined;
	let destroyed = false;
	let showGenerateButton = $state(false);
	let hydrating = $state(true);

	$effect(() => {
		if (isStreaming && streamStartedAt) {
			elapsedSeconds = Math.floor((Date.now() - streamStartedAt) / 1000);
			elapsedTimer = setInterval(() => {
				if (streamStartedAt) {
					elapsedSeconds = Math.floor((Date.now() - streamStartedAt) / 1000);
				}
			}, 1000);
		} else {
			if (elapsedTimer) {
				clearInterval(elapsedTimer);
				elapsedTimer = null;
			}
		}
		return () => {
			if (elapsedTimer) {
				clearInterval(elapsedTimer);
				elapsedTimer = null;
			}
		};
	});

	function formatElapsed(seconds: number): string {
		const m = Math.floor(seconds / 60);
		const s = seconds % 60;
		if (m === 0) return `${s}s`;
		return `${m}m ${s.toString().padStart(2, '0')}s`;
	}

	// analyzing happens in the same agent turn as the last exploration step;
	// map it to exploring so the skeleton phase check works correctly.
	function normalizePhase(p: string): string {
		if (p === 'connecting' || p === 'analyzing') return 'exploring';
		if (p === 'finishing') return 'writing';
		return p;
	}

	// ── Pipeline phase indicator (A→B→C→D) ──────────────────────────────
	// The pipeline phase is the agent-side content pointer: what has been
	// *persisted*, not what the model is currently doing. Drives a 4-step
	// progress indicator rendered in the walkthrough header while the stream
	// is live — on completion we hide it (all 4 steps filled carries no info
	// at rest).
	const PIPELINE_STEPS = [
		{ key: 'A', label: 'Overview' },
		{ key: 'B', label: 'Diff analysis' },
		{ key: 'C', label: 'Sentiment' },
		{ key: 'D', label: 'Rated' },
	] as const;

	const PIPELINE_STEP_INDEX: Record<'none' | 'A' | 'B' | 'C' | 'D', number> = {
		none: 0,
		A: 1,
		B: 2,
		C: 3,
		D: 4,
	};

	const pipelineCompletedCount = $derived(PIPELINE_STEP_INDEX[lastCompletedPhase]);

	// "All phases done" needs actual evidence of completion. A fresh PR with
	// no content shouldn't flash all checkmarks just because !isStreaming — so
	// we require that we actually have SOMETHING to show for it.
	const hasWalkthroughContent = $derived(
		summary !== null || blocks.length > 0 || ratings.length > 0
	);
	const allPhasesDone = $derived(!isStreaming && hasWalkthroughContent);

	// ── Stepper visibility ──────────────────────────────────────────────
	// Hidden only in the initial "not yet generated" state (when the
	// "Generate walkthrough" button is showing and nothing has started).
	// Visible once streaming begins, after content exists, or whenever
	// the generate button is not shown.
	const stepperVisible = $derived(!showGenerateButton || isStreaming || hasWalkthroughContent);

	// ── Unique files explored ───────────────────────────────────────────
	const filesExplored = $derived(() => {
		const files = new Set<string>();
		for (const step of explorationSteps) {
			// Extract file path from description (the exploration descriptions typically start with the path)
			const desc = step.description;
			if (desc && !desc.startsWith('*') && !desc.startsWith('"')) {
				const match = desc.match(/^([^\s]+\.\w+)/);
				if (match?.[1]) files.add(match[1]);
			}
		}
		return files.size;
	});

	// ── Scroll tracking ─────────────────────────────────────────────────
	// The scroll container lives in the parent page. We only *track* its
	// position (to show a "new content" pill); we never programmatically
	// scroll. A walkthrough is something you read top-to-bottom — yanking
	// the scroll to the tail while the user is still reading the summary
	// is hostile. The pill lets them jump down explicitly if they want.
	let userScrolledUp = $state(false);

	function scrollToBottom() {
		if (!scrollRoot) return;
		userScrolledUp = false;
		scrollRoot.scrollTo({ top: scrollRoot.scrollHeight, behavior: 'smooth' });
	}

	$effect(() => {
		if (!scrollRoot || !isActive) return;
		const el = scrollRoot;
		const onScroll = () => {
			const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
			userScrolledUp = !atBottom && el.scrollTop > 0;
		};
		el.addEventListener('scroll', onScroll);
		return () => el.removeEventListener('scroll', onScroll);
	});

	// ── Stagger tracking ────────────────────────────────────────────────
	// Assign a per-block entrance delay the first time each block is
	// observed. Blocks added in the same reactive tick form an "arrival
	// batch" and cascade — so a cached walkthrough, a mid-stream tick,
	// or an end-of-stream flush all fan out smoothly instead of slamming
	// in as a wall of text. Delays are memoized so later re-renders
	// don't re-trigger animations for blocks already on screen.

	const STAGGER_MS = 85;
	const STAGGER_CAP = 10;

	// Legacy-row suppression: older walkthroughs (pre-Phase C field) encoded
	// the sentiment paragraph as a markdown block starting with "## Overall
	// Sentiment". When the new `sentiment` field is populated, we drop any
	// such block here so rehydrated data doesn't render the paragraph twice.
	// When `sentiment` is null we leave legacy blocks in place — they're the
	// only copy we have.
	const visibleBlocks = $derived.by(() => {
		if (sentiment === null) return blocks;
		return blocks.filter(
			(b) =>
				!(
					b.type === 'markdown' &&
					b.content.trimStart().startsWith('## Overall Sentiment')
				),
		);
	});

	const blocksWithDelay = $derived.by(() => {
		let newInBatch = 0;
		return visibleBlocks.map((block) => {
			// Pre-render annotation markdown once per block so the template can
			// emit the annotation as a sibling grid item without each re-render
			// re-parsing markdown. Only code/diff blocks carry annotations.
			const renderedAnnotation =
				(block.type === 'code' || block.type === 'diff') && block.annotation
					? renderMarkdown(block.annotation)
					: null;
			if (hasBlockAnimated(prId, block.id)) {
				// Already animated in a previous mount — skip animation entirely
				return { block, delay: -1, renderedAnnotation };
			}
			// New block — assign staggered delay and record it immediately
			const delay = Math.min(newInBatch, STAGGER_CAP) * STAGGER_MS;
			markBlockAnimated(prId, block.id);
			newInBatch += 1;
			return { block, delay, renderedAnnotation };
		});
	});

	// Mirror the block-stagger logic for issue cards. Issue cards have their
	// own CSS entrance animation (`issue-card-enter`), so without tracking they
	// replay on every tab revisit the same way blocks used to.
	const issueDelayById = $derived.by(() => {
		const map = new Map<string, number>();
		let newInBatch = 0;
		for (const issue of issues) {
			if (hasIssueAnimated(prId, issue.id)) {
				map.set(issue.id, -1);
				continue;
			}
			const delay = Math.min(newInBatch, STAGGER_CAP) * STAGGER_MS;
			markIssueAnimated(prId, issue.id);
			newInBatch += 1;
			map.set(issue.id, delay);
		}
		return map;
	});

	// ── Container animation gating ──────────────────────────────────────
	// One-shot entrance animations for the stepper, content wrapper, summary,
	// and issues section. Each element carries a `*--no-anim` class whose value
	// is a reactive `$state` flag; the flag flips to `true` on `animationend`.
	// After that, the class stays applied for the life of the component — so
	// tab-switch display toggles, which in browsers normally restart CSS
	// animations on subtrees re-entering the render tree, find `animation:
	// none` and do nothing.
	//
	// Initial values come from the store so remounting the component for a PR
	// the user has already viewed doesn't replay the first animation either.
	// The effect below re-syncs from the store when the content identity
	// changes (regenerate → new `streamStartedAt`, or the component is reused
	// for a different PR → new `prId`), because `regenerate()` clears the
	// trackers for fresh content to animate again.
	// Seed from the tracker — `untrack` makes it explicit that we want the
	// one-shot value at mount time. The $effect below handles any later
	// reactive re-sync (regenerate, or the component instance being reused
	// for a different PR — the latter won't happen with SvelteKit's route
	// remount semantics, but we guard for it anyway).
	let stepperAnimated = $state(untrack(() => hasContainerAnimated(prId, 'stepper')));
	let contentAnimated = $state(untrack(() => hasContainerAnimated(prId, 'content')));
	let summaryAnimated = $state(untrack(() => hasContainerAnimated(prId, 'summary')));
	let issuesSectionAnimated = $state(untrack(() => hasContainerAnimated(prId, 'issues-section')));

	let lastSyncedFor: string | null = untrack(() => `${prId}:${streamStartedAt ?? 'init'}`);
	$effect(() => {
		const key = `${prId}:${streamStartedAt ?? 'init'}`;
		if (key === lastSyncedFor) return;
		lastSyncedFor = key;
		stepperAnimated = hasContainerAnimated(prId, 'stepper');
		contentAnimated = hasContainerAnimated(prId, 'content');
		summaryAnimated = hasContainerAnimated(prId, 'summary');
		issuesSectionAnimated = hasContainerAnimated(prId, 'issues-section');
	});

	type ContainerKey = 'stepper' | 'content' | 'summary' | 'issues-section';

	function lockContainerAnimation(key: ContainerKey, event: AnimationEvent): void {
		// Filter out bubbled events from descendants (issue-card-enter bubbles
		// up through .issues-section, block-slide-up through .walkthrough-content).
		if (event.target !== event.currentTarget) return;
		markContainerAnimated(prId, key);
		if (key === 'stepper') stepperAnimated = true;
		else if (key === 'content') contentAnimated = true;
		else if (key === 'summary') summaryAnimated = true;
		else issuesSectionAnimated = true;
	}

	// ── Issue → step navigation ─────────────────────────────────────────
	// Issues carry `blockIds` — the block(s) that explain them. Clicking an
	// issue card scrolls to the first linked block and briefly pulses it so
	// the user visually connects the card they clicked to the block they
	// landed on. Handled with a DOM lookup + requestAnimationFrame to avoid
	// piping refs through every block component.

	function stepNumberFor(blockId: string): number | null {
		// Use visibleBlocks so the step number matches the user-facing ordinal.
		// A legacy "## Overall Sentiment" block, when suppressed, must not shift
		// the numbering that the user sees in the rendered walkthrough.
		const idx = visibleBlocks.findIndex((b) => b.id === blockId);
		return idx >= 0 ? idx + 1 : null;
	}

	// ── Block → flagged-issue severity ─────────────────────────────────
	// For each block referenced by at least one issue, pick the highest
	// severity across all issues pointing at it. Used to render a colored dot
	// to the left of the block so the reader can spot flagged steps while
	// scrolling without having to cross-reference the Issues section.
	const SEVERITY_RANK: Record<'info' | 'warning' | 'critical', number> = {
		info: 1,
		warning: 2,
		critical: 3,
	};
	const blockIssueSeverity = $derived.by(() => {
		const map = new Map<string, 'info' | 'warning' | 'critical'>();
		for (const issue of issues) {
			for (const bid of issue.blockIds) {
				const current = map.get(bid);
				if (!current || SEVERITY_RANK[issue.severity] > SEVERITY_RANK[current]) {
					map.set(bid, issue.severity);
				}
			}
		}
		return map;
	});

	function jumpToStep(blockId: string): void {
		const el = document.getElementById(`step-${blockId}`);
		if (!el || !scrollRoot) return;
		// Compute offset relative to the scroll container so repeated clicks
		// always trigger a scroll (scrollIntoView is a no-op when already in view)
		const containerRect = scrollRoot.getBoundingClientRect();
		const elRect = el.getBoundingClientRect();
		const offset = elRect.top - containerRect.top + scrollRoot.scrollTop - 16;
    scrollRoot.scrollTo({ top: offset, behavior: 'smooth' });
    // Defer the highlight class toggle to the next animation frame so the
    // forced reflow doesn't cancel the smooth scroll we just initiated
    requestAnimationFrame(() => {
        el.classList.remove('block-wrapper--highlighted');
        void el.offsetWidth;
        el.classList.add('block-wrapper--highlighted');
    });
	}

	// Cross-tab jump: when another tab (e.g. Request Changes) calls
	// jumpToWalkthroughBlock(), the store flips activeTab → 'walkthrough' and
	// stashes the blockId. We consume it here once we're active + scrollRoot is
	// bound. One rAF of slack lets the display swap (`display: none` → `display:
	// contents`) settle so getBoundingClientRect returns real geometry.
	$effect(() => {
		const pendingBlockId = getPendingWalkthroughBlockJump();
		if (!pendingBlockId) return;
		if (!isActive || !scrollRoot) return;
		requestAnimationFrame(() => {
			jumpToStep(pendingBlockId);
			clearPendingWalkthroughBlockJump();
		});
	});

	onMount(() => {
		initHighlighter();
		// Seed a loading entry synchronously so the UI renders the skeleton
		// while we check the cache. Without this, the derived state resolves
		// to defaults (no summary, not streaming, no error) and the template
		// briefly shows the "No walkthrough data received" empty state.
		prepareEntry(prId);
		// Try to hydrate instantly from the JSON cache endpoint. On a hit the
		// walkthrough renders immediately with no SSE round-trip. On a miss
		// we fall back to the debounced SSE stream — the debounce is intentional
		// for uncached PRs so quickly arrowing through the PR list doesn't
		// trigger spurious AI generations.
		hydrateFromCache(prId).then((hit) => {
			hydrating = false;
			if (!hit && !destroyed) {
				showGenerateButton = true;
			}
		});
	});

	onDestroy(() => {
		destroyed = true;
		if (elapsedTimer) clearInterval(elapsedTimer);
		if (walkthroughDebounce) clearTimeout(walkthroughDebounce);
		stopClonePoll(prId);
	});

	// ── Clone-in-progress auto-retry ────────────────────────────────────
	// When the server rejects the walkthrough because the repo is still
	// cloning, we used to rely solely on a WS-delivered `cloneStatus === 'ready'`
	// update to auto-retry. That's fragile: missed WS messages, server restarts
	// that reset clone state to 'pending', and outright clone failures would
	// leave the UI permanently stuck on "Cloning repository…". Now we start a
	// poller against `GET /api/repos/:id/clone-status` that is authoritative for
	// all terminal states (ready/error/pending) regardless of WS delivery. The
	// WS fast-path still runs: if the repositories store already reports 'ready'
	// (from a WS broadcast) we stream immediately without waiting for the next
	// poll tick.
	$effect(() => {
		if (!cloneInProgress || !cloneRepoId) return;
		const repo = repositories.find((r) => r.id === cloneRepoId);
		if (repo?.cloneStatus === 'ready') {
			streamWalkthrough(prId);
			return;
		}
		void pollCloneUntilResolved(prId, cloneRepoId);
		return () => stopClonePoll(prId);
	});

	// ── Retry-clone button (escape hatch) ────────────────────────────────
	// Visible when the UI is stuck in the clone-in-progress state. Hits the
	// server's `/retry-clone` endpoint, which resets the repo's clone state and
	// kicks off a fresh clone, then restarts the poller so the UI un-sticks
	// regardless of whether the WS fast-path fires.
	let retryingClone = $state(false);
	async function handleRetryClone(): Promise<void> {
		if (!cloneRepoId || retryingClone) return;
		const repoId = cloneRepoId;
		retryingClone = true;
		try {
			await fetch(`${API_BASE_URL}/api/repos/${repoId}/retry-clone`, {
				method: 'POST',
				headers: authHeaders(),
			});
			void pollCloneUntilResolved(prId, repoId);
		} finally {
			retryingClone = false;
		}
	}

	// ── Regenerate ──────────────────────────────────────────────────────
	function handleRegenerate(): void {
		regenerate(prId);
	}
</script>

<div class="walkthrough">
	{#if superseded}
		<!-- Outdated-walkthrough banner. The server marked this row 'superseded'
		     because a new commit landed mid-render and a fresher walkthrough
		     was created for the newer head SHA. Regenerate swaps this entry for
		     the new one via the /walkthrough/regenerate endpoint. -->
		<div class="walkthrough-banner" role="status">
			<div class="walkthrough-banner-row walkthrough-banner-row--superseded">
				<div class="walkthrough-banner-icon">
					<AlertCircle size={16} />
				</div>
				<div class="walkthrough-banner-body">
					<p class="walkthrough-banner-title">This walkthrough is outdated</p>
					<p class="walkthrough-banner-subtitle">
						The PR has new commits since this review was generated.
					</p>
				</div>
				<Button variant="outline" size="sm" style="cursor: pointer;" onclick={handleRegenerate}>
					<RefreshCw size={14} />
					Regenerate
				</Button>
			</div>
		</div>
	{/if}
	{#if !streamError}
		{#if stepperVisible}
			{#if phase === 'connecting' && isStreaming && !hasWalkthroughContent}
				<!-- Indeterminate progress bar during initial connection phase -->
				<div class="walkthrough-connect-progress">
					<Progress indeterminate class="h-1" />
				</div>
			{/if}
			<!-- Persistent progress header. Shown through every phase and remains
			     on screen after the stream completes so the user keeps a map of
			     what happened. Rendered outside the main branching so it stays
			     visible when we switch from the skeleton (loading) view to the
			     real content (writing/finishing) view. -->
			<div
				class="walkthrough-stepper-header"
				class:walkthrough-stepper-header--no-anim={stepperAnimated}
				onanimationend={(e) => lockContainerAnimation('stepper', e)}
			>
				<!-- Pipeline phase indicator (A→B→C→D). Only while generating —
				     a fully-complete walkthrough shows 4/4 dots that carry no
				     new signal at rest, and a terminal error is already covered
				     by the error view below. Tracks *persisted* content phases. -->
				{#if isStreaming}
					<div
						class="pipeline-phase"
						role="progressbar"
						aria-label="Walkthrough pipeline phase"
						aria-valuenow={pipelineCompletedCount}
						aria-valuemin={0}
						aria-valuemax={PIPELINE_STEPS.length}
					>
						{#each PIPELINE_STEPS as step, i (step.key)}
							{@const isDone = i < pipelineCompletedCount}
							{@const isCurrent = i === pipelineCompletedCount}
							<div
								class="pipeline-step"
								class:pipeline-step--done={isDone}
								class:pipeline-step--current={isCurrent}
							>
								<div class="pipeline-step-dot">
									{#if isDone}
										<CheckCircle size={12} />
									{:else}
										<Circle size={12} />
									{/if}
								</div>
								<span class="pipeline-step-label">{step.label}</span>
							</div>
							{#if i < PIPELINE_STEPS.length - 1}
								<div class="pipeline-connector" class:pipeline-connector--done={isDone}></div>
							{/if}
						{/each}
					</div>
				{/if}

			</div>
		{/if}
	{/if}

	{#if streamError && !summary && blocks.length === 0}
		<!-- Error state: no data at all -->
		<div class="walkthrough-empty">
			{#if explorationSteps.length > 0}
				<div class="exploration-feed exploration-feed--error">
					{#each explorationSteps.slice(-6) as step, i (i)}
						<div class="exploration-item">
							<span class="exploration-tool">{step.tool}</span>
							<span class="exploration-desc">{step.description}</span>
						</div>
					{/each}
				</div>
			{/if}
			<pre class="error-text">{streamError}</pre>
			{#if streamError.includes('not configured') || streamError.includes('API key')}
				<p class="error-hint">Add your Anthropic API key in Settings to enable walkthroughs.</p>
			{/if}
		<Button variant="outline" size="lg" style="cursor: pointer;" onclick={handleRegenerate}>
			<RefreshCw size={16} />
			Try again
		</Button>
	</div>
	{:else if cloneInProgress && !summary && blocks.length === 0}
		<!-- Clone-in-progress state: show indeterminate progress bar + Retry
		     escape hatch. The poller set up in the $effect above drives this
		     view to a terminal state (streamWalkthrough on 'ready', or a
		     streamError branch on 'error'/'pending'), but a stuck server or
		     network partition can still happen — the Retry button gives the
		     user an explicit way out. When cloneRepoId is somehow null (SSE
		     error event didn't carry it), we can't address the retry at a
		     specific repo, so we fall back to a generic Try again that
		     regenerates the walkthrough. -->
		{@const repo = cloneRepoId ? repositories.find((r) => r.id === cloneRepoId) : null}
		{@const repoError = repo?.cloneError ?? null}
		<div class="walkthrough-empty">
			{#if !cloneRepoId}
				<AlertTriangle size={20} />
				<p class="loading-text">Couldn't identify the repository that was cloning.</p>
			<Button variant="outline" size="lg" style="cursor: pointer;" onclick={handleRegenerate}>
				<RefreshCw size={16} />
				Try again
			</Button>
			{:else}
				<div class="clone-progress-container">
					<p class="loading-text">Cloning repository…</p>
					<Progress indeterminate class="clone-progress-bar" />
					<p class="loading-subtext">The walkthrough will start automatically when cloning completes.</p>
					{#if repoError}
						<pre class="error-text">{repoError}</pre>
					{/if}
                <Button
                    variant="outline"
                    size="lg"
                    style="cursor: pointer;"
                    disabled={retryingClone}
                    onclick={handleRetryClone}
                >
                    <RefreshCw size={16} />
                    Retry clone
                </Button>
				</div>
			{/if}
		</div>
	{:else if showGenerateButton && !isStreaming && !summary && blocks.length === 0}
		<div class="walkthrough-empty">
			<p class="loading-text">No walkthrough generated yet for this PR.</p>
			<Button variant="outline" size="lg" style="cursor: pointer;" onclick={() => { showGenerateButton = false; streamWalkthrough(prId); }}>
				<Sparkles size={14} />
				Generate walkthrough
			</Button>
		</div>
	{:else if !summary && blocks.length === 0 && sentiment === null && ratings.length === 0 && isStreaming}
		<!-- Loading state: skeleton + exploration feed. Only shown before the
		     first MCP write lands. The moment Phase A's summary (or any later
		     phase's content) arrives, we fall through to the content branch
		     below so subsequent MCP writes — diff steps, sentiment, ratings —
		     render incrementally as they're committed.
		     The phase stepper lives above as a sibling of this branch so it
		     stays visible when we transition to the content view. -->
		<div class="walkthrough-loading">
			<!-- Status message + timer -->
			<div class="status-bar">
				<div class="status-message">
					<div class="status-dot"></div>
					<span>{phaseMessage}</span>
				</div>
				<span class="elapsed-time">{formatElapsed(elapsedSeconds)}</span>
			</div>

			<!-- Skeleton placeholder: only shown during the Analyze phase -->
			{#if normalizePhase(phase) === 'writing'}
				<div class="skeleton-body" aria-hidden="true">
					<div class="skeleton-summary">
						<Skeleton class="h-[22px] w-[60px] rounded-full" />
						<Skeleton class="h-[14px] w-[95%]" />
						<Skeleton class="h-[14px] w-[80%]" />
						<Skeleton class="h-[14px] w-[50%]" />
					</div>

					<div class="skeleton-separator"></div>

					<div class="skeleton-card">
						<div class="skeleton-card-body">
							<Skeleton class="h-[14px] w-[90%]" />
							<Skeleton class="h-[14px] w-full" />
							<Skeleton class="h-[14px] w-[85%]" />
							<Skeleton class="h-[14px] w-[75%]" />
							<Skeleton class="h-[14px] w-[60%]" />
						</div>
					</div>
				</div>
			{/if}

			<!-- Exploration feed -->
			{#if explorationSteps.length > 0}
				<div class="exploration-section">
					<div class="exploration-header">
						<FileText size={12} />
						<span>
							{explorationSteps.length} operation{explorationSteps.length !== 1 ? 's' : ''}
							{#if filesExplored() > 0}
								across {filesExplored()} file{filesExplored() !== 1 ? 's' : ''}
							{/if}
						</span>
					</div>
					<div class="exploration-feed">
						{#each explorationSteps.slice(-8) as step, i (i)}
							<div class="exploration-item">
								<span class="exploration-tool">{step.tool}</span>
								<span class="exploration-desc">{step.description}</span>
							</div>
						{/each}
						<div class="exploration-cursor">
							<span class="cursor-dot"></span>
							<span class="cursor-dot"></span>
							<span class="cursor-dot"></span>
						</div>
					</div>
				</div>
			{/if}
		</div>
	{:else if !summary && !isStreaming && !streamError && !hydrating}
		<!-- Stream ended with no data -->
		<div class="walkthrough-empty">
			<p class="loading-text">No walkthrough data received. The AI may have timed out.</p>
	<Button variant="outline" size="lg" style="cursor: pointer;" onclick={handleRegenerate}>
		<RefreshCw size={16} />
		Try again
	</Button>
	</div>
	{:else if summary}
		<!-- Landing page content -->
		<div
			class="walkthrough-content"
			class:walkthrough-content--no-anim={contentAnimated}
			onanimationend={(e) => lockContainerAnimation('content', e)}
		>
			<!-- Summary header -->
		<div
			class="summary-section"
			class:summary-section--no-anim={summaryAnimated}
			onanimationend={(e) => lockContainerAnimation('summary', e)}
		>
			<h2 class="summary-heading">Overview</h2>
			<!-- div, not p: renderMarkdown emits its own <p> elements, so wrapping
			     in <p> would nest block elements illegally. -->
			<div class="summary-text">{@html renderedSummary}</div>
				{#if streamError}
					<p class="error-inline">{streamError}</p>
				{/if}
				{#if isStreaming}
					<div class="summary-actions">
					<span class="streaming-indicator">
						<Loader2 size={12} class="animate-spin" />
						{phaseMessage}
					</span>
					</div>
				{/if}
			</div>

			<Separator />

			<!-- Issues — bucketed by severity (Critical → Warning → Info) so the
			     reviewer's eye lands on blockers before nice-to-knows. The overall
			     "N issues flagged" line is preserved as the section header; each
			     bucket then carries its own labeled sub-header with a count. -->
			{#if issues.length > 0}
				<div
					class="issues-section"
					class:issues-section--no-anim={issuesSectionAnimated}
					onanimationend={(e) => lockContainerAnimation('issues-section', e)}
				>
					<div class="issues-header">
						<AlertTriangle size={13} />
						<span>{issues.length} issue{issues.length !== 1 ? 's' : ''} flagged</span>
					</div>
					<div class="issues-groups">
						{#each issueGroups as group (group.severity)}
							<div class="issues-group">
								<div class="issues-group-header issues-group-header--{group.severity}">
									<span class="issues-group-dot"></span>
									<span class="issues-group-label">{group.label}</span>
									<span class="issues-group-count">{group.issues.length}</span>
								</div>
								<div class="issues-list">
									{#each group.issues as { issue, globalIndex } (issue.id)}
										{@const targetBlockId = issue.blockIds?.[0] ?? null}
										{@const stepN = targetBlockId ? stepNumberFor(targetBlockId) : null}
										<!-- Gate clickability on the referenced block actually existing in
										     the current render. `blockIds` can point to a block that isn't in
										     `blocks` (kept issues after regenerate, or a mid-stream race
										     between the issue arriving and its block rendering) — in which
										     case jumpToStep would silently no-op and the click would feel
										     broken. stepN is null whenever the lookup fails, which catches
										     both a missing targetBlockId and an id that doesn't resolve. -->
										{#if stepN !== null && targetBlockId}
											<IssueCard
												{issue}
												clickable
												onclick={() => jumpToStep(targetBlockId)}
												stepTag={`→ Step ${stepN}`}
												animationDelay="{Math.min(globalIndex, 6) * 50}ms"
												noAnim={issueDelayById.get(issue.id) === -1}
												onfileclick={(filePath, line) => jumpToDiffLine(filePath, line)}
												hideFileBadge={true}
											/>
										{:else}
											<IssueCard
												{issue}
												stepTag={null}
												animationDelay="{Math.min(globalIndex, 6) * 50}ms"
												noAnim={issueDelayById.get(issue.id) === -1}
												onfileclick={(filePath, line) => jumpToDiffLine(filePath, line)}
												hideFileBadge={true}
											/>
										{/if}
									{/each}
								</div>
							</div>
						{/each}
					</div>
				</div>
				<Separator />
			{/if}

			<!-- Blocks — Phase B diff-analysis content. Phase C (sentiment) and
			     Phase D (scorecard) live in their own cards below the loop now
			     that sentiment is a first-class walkthrough field rather than a
			     magic markdown-block convention. Legacy rows that still carry
			     a "## Overall Sentiment" block are filtered upstream in
			     `visibleBlocks` when `sentiment` is populated. -->
			<div class="blocks">
			{#each blocksWithDelay as { block, delay, renderedAnnotation }, blockIndex (block.id)}
				{@const hasAnnotation = renderedAnnotation !== null}
				{@const blockSeverity = blockIssueSeverity.get(block.id) ?? null}

				<!-- `.block-group` is a transparent wrapper (display: contents) so
				     .block-wrapper and .block-annotation become direct grid items
				     of .blocks and land in their own columns. -->
				<div class="block-group">
					<span
						class="block-step-number"
						class:block-step-number--info={blockSeverity === 'info'}
						class:block-step-number--warning={blockSeverity === 'warning'}
						class:block-step-number--critical={blockSeverity === 'critical'}
					>#{blockIndex + 1}</span>
					<div
						id="step-{block.id}"
						class="block-wrapper"
						class:block-wrapper--no-anim={delay === -1}
						style:--enter-delay="{delay}ms"
					>
						{#if block.type === 'markdown'}
							<WalkthroughMarkdownBlock content={block.content} />
						{:else if block.type === 'code'}
							<WalkthroughCodeBlock {block} {themeType} hideAnnotation />
						{:else if block.type === 'diff'}
							<WalkthroughDiffBlock {block} {themeType} hideAnnotation />
						{/if}
					</div>

					{#if hasAnnotation}
						<!-- Annotation rail: Notion-style floating note to the right of
						     its block. Animation delay matches the block's so rail text
						     and block slide in in sync. The same `delay === -1` sentinel
						     used elsewhere suppresses re-animation on tab-revisit. -->
						<aside
							class="block-annotation"
							class:block-annotation--no-anim={delay === -1}
							style:--enter-delay="{delay}ms"
							aria-label="Annotation"
						>
							<div class="block-annotation-inner">
								{@html renderedAnnotation}
							</div>
						</aside>
					{/if}
				</div>
			{/each}

			<!-- Phase C / D conclusion: sentiment card above the scorecard.
			     Rendered as a single grid item (block-group--sentiment-stack)
			     so the pair spans the content column cleanly regardless of how
			     many diff steps preceded it. Hidden when neither field exists
			     — e.g. a freshly-started stream that hasn't reached Phase C. -->
			{#if sentiment !== null || ratings.length > 0}
				<div class="block-group block-group--sentiment-stack">
					{#if sentiment !== null}
						<div class="sentiment-card" aria-label="Overall sentiment">
							<div class="sentiment-card-header">
								<h3 class="sentiment-card-title">Overall Sentiment</h3>
							</div>
							<div class="sentiment-card-body">{@html renderedSentiment}</div>
						</div>
					{/if}
					{#if ratings.length > 0}
						<div class="sentiment-scorecard">
							<WalkthroughRatingsGrid {ratings} blocks={visibleBlocks} onJump={jumpToStep} />
						</div>
					{/if}
				</div>
			{/if}
			</div>

			{#if isStreaming && blocks.length > 0}
				<div class="streaming-bottom">
					<div class="typing-indicator">
						<span class="typing-dot"></span>
						<span class="typing-dot"></span>
						<span class="typing-dot"></span>
					</div>
					<p class="loading-text">{phaseMessage}</p>
					{#if explorationSteps.length > 0}
						<p class="loading-subtext">
							{explorationSteps.length} operations completed
						</p>
					{/if}
				</div>
			{/if}

			<!-- Scorecard lives inline under the Overall Sentiment card now
			     (see the .blocks loop above). No end-of-walkthrough rendering. -->
		</div>

		<!-- Scroll-to-bottom floating button -->
		{#if userScrolledUp && isStreaming}
		<Button variant="secondary" class="scroll-to-bottom" onclick={scrollToBottom}>
			<ArrowDown size={14} />
			New content
		</Button>
		{/if}
	{/if}
</div>

<style>
	.walkthrough {
		display: flex;
		flex-direction: column;
		background: var(--color-bg-primary);
	}

	.walkthrough-content {
		/* 6-col grid that anchors the content column to the VIEWPORT centre
		   (not the main-area centre), so resizing or toggling the left pane
		   doesn't shift the content horizontally. Content only moves left —
		   and only by exactly the required distance — when the main-area
		   has shrunk enough that rail-plus-content would overflow.

		   col 1 = max(24px, min(100% - 50vw - 458px, 100% - 1312px))
		     - 100% - 50vw - 458px : the col_1 width that places the content
		         column's centre at viewport x = 50vw. Derivation: sidebar
		         width S = 100vw - 100% (because 100% = main-area width =
		         V - S). Content's viewport x-centre = S + col_1 + 48 + 410;
		         setting that to V/2 = 50vw gives col_1 = 100% - 50vw - 458.
		         When S changes (sidebar toggle/resize), 100% and 50vw shift
		         in lockstep so that S + col_1 + 458 stays at V/2 — content
		         position in the viewport is stable.
		     - 100% - 1312px : the largest col_1 that still lets the rail end
		         at exactly 100% - 24 (24px right gutter inside main-area).
		         When this binds (narrow main-area), content's viewport x
		         = S + (100% - 1312) + 458 = V - 854 — also independent of S,
		         so toggling the sidebar still doesn't jump the content.
		     min() picks whichever binds. They cross when V ≥ 1708 (viewport,
		     not main-area); above, viewport-centring wins; below, rail
		     pinning wins. Floor of 24px keeps a minimum left gutter.
		   col 2 = 48        (step-number gutter)
		   col 3 = 820       (content)
		   col 4 = 40        (content ↔ rail gap)
		   col 5 = 380       (annotation rail)
		   col 6 = 1fr, ≥ 24 (right gutter; absorbs excess past the rail)

		   Geometric min of main-area width = 24 + 48 + 820 + 40 + 380 + 24
		   = 1336. Below that the side-by-side grid physically doesn't fit;
		   the @container rule at the bottom falls through to a stacked
		   layout. The breakpoint is on main-area width (100%, via
		   container-type: inline-size on .review-content) so the collapse
		   triggers only when the sidebar has eaten enough room to matter. */
		display: grid;
		grid-template-columns:
			max(24px, min(calc(100% - 50vw - 458px), calc(100% - 1312px)))
			48px
			minmax(0, 820px)
			40px
			380px
			minmax(24px, 1fr);
		padding: 28px 0;
		animation: fadeIn 0.28s cubic-bezier(0.22, 0.61, 0.36, 1) 60ms both;
	}

	/* Single-column sections live in the content column (col 3). The Separator
	   and streaming-bottom are direct children; .summary-section and
	   .issues-section sit there too. */
	.walkthrough-content > .summary-section,
	.walkthrough-content > .issues-section,
	.walkthrough-content > .streaming-bottom,
	.walkthrough-content > :global([data-slot="separator"]) {
		grid-column: 3;
	}

	/* Suppress the entrance animation on tab revisits. Paired with the
	   `walkthrough-content--no-anim` class toggled from the component script
	   after the first `animationend` — without this, browsers restart the
	   animation when the subtree re-enters the render tree after the tab's
	   `display: none` is lifted. */
	.walkthrough-content--no-anim {
		animation: none;
		opacity: 1;
	}

	/* Viewport-anchored centering for the empty state — mirrors the approach
	   used by `.walkthrough-content` but simplified because there is NO side
	   rail in the empty state, so we don't need to reserve col 5.
	   Using the content-layout's full 6-col formula here would clamp col_1 to
	   its 24px floor on common laptop widths (the `100% - 1312px` term
	   reserves space for a rail that doesn't exist), pushing the Try again /
	   Generate walkthrough button hard-left instead of viewport-centered.

	   col 1 = max(24px, calc(100% - 50vw - 410px))
	     - 100% - 50vw - 410px : places col-2 centre at viewport x = 50vw.
	         Derivation: sidebar width S = 100vw - 100% (since 100% = main
	         width = V - S). Content viewport-centre = S + col_1 + 410;
	         setting that to V/2 = 50vw gives col_1 = 100% - 50vw - 410. When
	         S changes via pane toggle, `100%` and `50vw` shift in lockstep
	         so content viewport x stays at V/2 — no horizontal jump.
	     - 24px floor : fallback on viewports so narrow that viewport-centering
	         would overlap the sidebar. In that regime the jump is
	         geometrically unavoidable; 24px at least keeps the content inside
	         the main area.
	   col 2 = 820px content track (same width as `.walkthrough-content` col 3
	           for visual parity with the populated state).
	   col 3 = minmax(24px, 1fr) right gutter; soaks up remaining space. */
	.walkthrough-empty {
		display: grid;
		grid-template-columns:
			max(24px, calc(100% - 50vw - 410px))
			minmax(0, 820px)
			minmax(24px, 1fr);
		align-content: center;
		justify-items: center;
		min-height: 60vh;
		padding: 80px 0;
		row-gap: 12px;
	}

	/* `:global(*)` — same reason as `.walkthrough-connect-progress > :global(*)`:
	   children include a shadcn Button and other components whose roots carry
	   a different Svelte scope hash, so a scoped `> *` rule would skip them
	   and they'd fall into grid auto-flow (landing in col 1/3 instead of col 2,
	   which is exactly the mis-placement that showed the Try again button
	   drifting into the rail column). */
	.walkthrough-empty > :global(*) {
		grid-column: 2;
	}

	/* Loading / stepper / connect-progress all use the SAME 6-col grid as
	   `.walkthrough-content` so their inner content lands in col 3 — the
	   820 content column — exactly where the streamed walkthrough blocks
	   will render. A plain max-width: 900; margin-inline: auto would NOT
	   align with col 3 because the asymmetric grid makes col 3 centered
	   in the viewport but cols 3–5 (including rail) are shifted right, so
	   a viewport-centered box lands offset from where content actually goes.
	   Grid here guarantees pixel-identical alignment with the eventual
	   walkthrough content column. */
	.walkthrough-loading {
		display: grid;
		grid-template-columns:
			max(24px, min(calc(100% - 50vw - 458px), calc(100% - 1312px)))
			48px
			minmax(0, 820px)
			40px
			380px
			minmax(24px, 1fr);
		padding: 28px 0;
		row-gap: 20px;
	}

	/* Each skeleton / status-bar / exploration-feed lands in col 3 (the 820
	   content column). */
	.walkthrough-loading > * {
		grid-column: 3;
	}

	/* ── Connect progress bar (shown during 'connecting' phase) ──────── */

	.walkthrough-connect-progress {
		display: grid;
		grid-template-columns:
			max(24px, min(calc(100% - 50vw - 458px), calc(100% - 1312px)))
			48px
			minmax(0, 820px)
			40px
			380px
			minmax(24px, 1fr);
		align-items: center;
		padding: 24px 0 4px;
		overflow: hidden;
	}

	/* `:global(*)` — Progress is a Svelte component from a different file,
	   so its root element has a different scope hash than this component.
	   A scoped `> *` selector would compile to `*.walkthrough-hash` and miss
	   the Progress root. Without :global, Progress falls to grid auto-flow
	   placement (lands in col 1 of the empty grid), not col 3. */
	.walkthrough-connect-progress > :global(*) {
		grid-column: 3;
	}

	.walkthrough-stepper-header {
		display: grid;
		grid-template-columns:
			max(24px, min(calc(100% - 50vw - 458px), calc(100% - 1312px)))
			48px
			minmax(0, 820px)
			40px
			380px
			minmax(24px, 1fr);
		padding: 24px 0 4px;
		animation: fadeIn 0.3s cubic-bezier(0.22, 0.61, 0.36, 1) both;
	}

	.walkthrough-stepper-header > * {
		grid-column: 3;
	}

	/* Tab-revisit override — see .walkthrough-content--no-anim for why. */
	.walkthrough-stepper-header--no-anim {
		animation: none;
		opacity: 1;
	}

	/* When the stepper header is present, tighten the top padding of the
	   following content/loading block so the two sections feel like one
	   continuous region instead of two stacked panels with a big gap. */
	.walkthrough-stepper-header + .walkthrough-loading,
	.walkthrough-stepper-header + .walkthrough-content {
		padding-top: 14px;
	}

	/* ── Pipeline phase (A→B→C→D) indicator ──────────────────────────
	   Rendered below the lifecycle stepper while generating. Distinct visual
	   language (small dots, muted until complete) so reviewers can tell at
	   a glance which is which — the lifecycle row tells them what the agent
	   is *doing* this instant, the pipeline row tells them what has been
	   *persisted*. */

	.pipeline-phase {
		display: flex;
		align-items: center;
		gap: 0;
		padding: 4px 0 8px;
		margin-top: 4px;
		border-top: 1px dashed color-mix(in srgb, var(--color-border) 60%, transparent);
		padding-top: 10px;
	}

	.pipeline-step {
		display: flex;
		align-items: center;
		gap: 5px;
		color: var(--color-text-muted);
		opacity: 0.45;
		transition: opacity 0.25s ease, color 0.25s ease;
	}

	.pipeline-step--current {
		color: var(--color-accent);
		opacity: 1;
	}

	.pipeline-step--done {
		color: var(--color-accent);
		opacity: 1;
	}

	.pipeline-step-dot {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 16px;
		height: 16px;
		flex-shrink: 0;
	}

	.pipeline-step--current .pipeline-step-dot {
		animation: pulseIcon 2s ease-in-out infinite;
	}

	.pipeline-step-label {
		font-size: 10.5px;
		font-weight: 500;
		letter-spacing: 0.03em;
		white-space: nowrap;
		text-transform: uppercase;
	}

	.pipeline-connector {
		flex: 1;
		height: 1px;
		background: var(--color-border);
		margin: 0 6px;
		min-width: 12px;
		transition: background 0.25s ease;
	}

	.pipeline-connector--done {
		background: var(--color-accent);
		opacity: 0.5;
	}

	/* ── Superseded banner ──────────────────────────────────────────────
	   Renders at the top of the walkthrough when the server marked this row
	   `superseded`. The outer grid aligns it with the content column (col 3
	   of the 6-col walkthrough grid), and the inner flex row stacks an icon,
	   a two-line message, and a Regenerate button on one line. */

	.walkthrough-banner {
		display: grid;
		grid-template-columns:
			max(24px, min(calc(100% - 50vw - 458px), calc(100% - 1312px)))
			48px
			minmax(0, 820px)
			40px
			380px
			minmax(24px, 1fr);
		padding: 14px 0 0;
	}

	.walkthrough-banner > .walkthrough-banner-row {
		grid-column: 3;
	}

	.walkthrough-banner-row {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 10px 12px;
		border-radius: 8px;
	}

	.walkthrough-banner-row--superseded {
		background: color-mix(in srgb, var(--color-warning) 8%, transparent);
		border: 1px solid color-mix(in srgb, var(--color-warning) 28%, transparent);
	}

	.walkthrough-banner-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		color: var(--color-warning);
	}

	.walkthrough-banner-body {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.walkthrough-banner-title {
		font-size: 13px;
		font-weight: 600;
		color: var(--color-text-primary);
		margin: 0;
	}

	.walkthrough-banner-subtitle {
		font-size: 12px;
		color: var(--color-text-muted);
		margin: 0;
	}

	/* ── Status bar ───────────────────────────────────────────────────── */

	.status-bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 10px 14px;
		background: color-mix(in srgb, var(--color-accent) 6%, transparent);
		border: 1px solid color-mix(in srgb, var(--color-accent) 15%, transparent);
		border-radius: 8px;
	}

	.status-message {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 13px;
		color: var(--color-text-secondary);
	}

	.status-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--color-accent);
		animation: pulse 1.5s ease-in-out infinite;
		flex-shrink: 0;
	}

	.elapsed-time {
		font-size: 12px;
		font-family: var(--font-mono, monospace);
		color: var(--color-text-muted);
		font-variant-numeric: tabular-nums;
	}

	.elapsed-badge {
		font-size: 11px;
		font-family: var(--font-mono, monospace);
		color: var(--color-text-muted);
		font-variant-numeric: tabular-nums;
		padding: 2px 8px;
		background: var(--color-bg-tertiary);
		border-radius: 9999px;
	}

	/* ── Skeleton ──────────────────────────────────────────────────────── */

	.skeleton-body {
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.skeleton-summary {
		display: flex;
		flex-direction: column;
		gap: 8px;
		margin-bottom: 4px;
	}

	.skeleton-separator {
		height: 1px;
		background: var(--color-border);
		margin: 4px 0;
	}

	.skeleton-card {
		border: 1px solid var(--color-border);
		border-radius: 8px;
		overflow: hidden;
	}

	.skeleton-card-body {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 16px;
	}

	/* ── Exploration feed ──────────────────────────────────────────────── */

	.exploration-section {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.exploration-header {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 11px;
		font-weight: 500;
		color: var(--color-text-muted);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.exploration-feed {
		/* Fill the parent (.exploration-section → grid col 3, 820px). The
		   prior `max-width: 520px` dates from the old left-anchored layout and
		   now makes the tool-call list visually narrower than the skeleton and
		   status-bar siblings. */
		width: 100%;
		display: flex;
		flex-direction: column;
		gap: 3px;
		overflow: hidden;
		padding: 10px 12px;
		background: var(--color-bg-secondary);
		border-radius: 6px;
		border: 1px solid var(--color-border);
	}

	.exploration-item {
		display: flex;
		gap: 8px;
		font-size: 11px;
		font-family: var(--font-mono, monospace);
		color: var(--color-text-muted);
		animation: fadeIn 0.2s ease-in;
		line-height: 1.5;
	}

	.exploration-tool {
		color: var(--color-accent);
		flex-shrink: 0;
		min-width: 36px;
		font-weight: 500;
	}

	.exploration-desc {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.exploration-feed--error {
		opacity: 0.5;
		margin-bottom: 8px;
		/* Re-apply the readability cap for the error state, where the feed
		   lives inside the centered .walkthrough-empty (no grid col 3 to
		   constrain it). The loading-state feed doesn't need this because
		   .walkthrough-loading places it in col 3 (820 max). */
		max-width: 520px;
	}

	.exploration-cursor {
		display: flex;
		gap: 3px;
		padding-top: 2px;
	}

	.cursor-dot {
		width: 4px;
		height: 4px;
		border-radius: 50%;
		background: var(--color-accent);
		animation: cursorBounce 1.4s ease-in-out infinite;
	}

	.cursor-dot:nth-child(2) {
		animation-delay: 0.16s;
	}

	.cursor-dot:nth-child(3) {
		animation-delay: 0.32s;
	}

	/* ── Summary ──────────────────────────────────────────────────────── */

	.summary-section {
		margin-bottom: 20px;
		animation: content-enter 0.6s cubic-bezier(0.22, 0.61, 0.36, 1) both;
	}

	/* Tab-revisit override — see .walkthrough-content--no-anim for why. */
	.summary-section--no-anim {
		animation: none;
		opacity: 1;
		filter: none;
		transform: none;
	}

	.summary-header {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-bottom: 10px;
	}

	.summary-heading {
		font-size: 18px;
		font-weight: 700;
		color: var(--color-text-primary);
		margin: 0 0 6px;
	}

	.summary-text {
		font-size: 14px;
		line-height: 1.6;
		color: var(--color-text-secondary);
		margin: 0;
	}

	/* Markdown output (emitted by renderMarkdown) — matches the same tokens
	   the block-annotation rail uses so Overview inline code / bold / lists
	   read consistently with the rest of the walkthrough. :global() is
	   required because the HTML is injected via {@html}, so Svelte's scoped
	   class hashing can't reach those elements. */
	.summary-text :global(p) {
		margin: 0 0 8px;
	}

	.summary-text :global(p:last-child) {
		margin-bottom: 0;
	}

	.summary-text :global(code) {
		font-family: var(--font-mono);
		font-size: 12px;
		background: var(--color-bg-tertiary);
		padding: 1px 4px;
		border-radius: 3px;
	}

	.summary-text :global(strong) {
		color: var(--color-text-primary);
		font-weight: 600;
	}

	.summary-text :global(a) {
		color: var(--color-accent);
		text-decoration: underline;
		text-underline-offset: 2px;
	}

	.summary-text :global(ul),
	.summary-text :global(ol) {
		margin: 4px 0 8px;
		padding-left: 20px;
	}

	.summary-text :global(li) {
		margin: 2px 0;
	}

	.summary-actions {
		margin-top: 10px;
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.streaming-indicator {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 12px;
		color: var(--color-accent);
	}

	/* ── Issues layout ───────────────────────────────────────────────── */

	.issues-section {
		margin-top: 20px;
		margin-bottom: 4px;
		display: flex;
		flex-direction: column;
		gap: 10px;
		animation: content-enter 0.6s cubic-bezier(0.22, 0.61, 0.36, 1) 0.15s both;
	}

	/* Tab-revisit override — see .walkthrough-content--no-anim for why. */
	.issues-section--no-anim {
		animation: none;
		opacity: 1;
		filter: none;
		transform: none;
	}

	.issues-header {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 11px;
		font-weight: 600;
		color: var(--color-text-muted);
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.issues-groups {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	.issues-group {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.issues-group-header {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--color-text-secondary);
	}

	.issues-group-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--severity-color, var(--color-text-muted));
	}

	.issues-group-label {
		color: var(--severity-color, var(--color-text-secondary));
	}

	.issues-group-count {
		color: var(--color-text-muted);
		font-variant-numeric: tabular-nums;
		font-weight: 500;
	}

	.issues-group-header--critical { --severity-color: var(--color-danger); }
	.issues-group-header--warning { --severity-color: var(--color-warning); }
	.issues-group-header--info { --severity-color: var(--color-accent); }

	.issues-list {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	/* ── Blocks ──────────────────────────────────────────────────────── */

	/* Give every Separator inside the walkthrough content breathing room */
	.walkthrough-content :global([data-slot="separator"]) {
		margin: 28px 0;
	}

	.blocks {
		/* Blocks spans the full width of the walkthrough-content grid and
		   re-declares the same column tracks so its .block-wrapper (col 3) and
		   .block-annotation (col 5) align pixel-for-pixel with the single-column
		   sections above. Since .blocks spans `1 / -1` of its parent, its total
		   width equals the parent's total width, so the minmax tracks resolve
		   identically to the parent's — no subgrid needed. */
		display: grid;
		grid-column: 1 / -1;
		grid-template-columns:
			max(24px, min(calc(100% - 50vw - 458px), calc(100% - 1312px)))
			48px
			minmax(0, 820px)
			40px
			380px
			minmax(24px, 1fr);
		row-gap: 20px;
		margin-top: 20px;
		grid-auto-flow: row;
	}

	/* Transparent wrapper: .block-wrapper and .block-annotation become direct
	   grid items of .blocks via display:contents. Explicit grid-column
	   assignments below are what force each item into its correct column —
	   without them, a block without an annotation would let the next block's
	   wrapper slip into col 2 via auto-placement. */
	.block-group {
		display: contents;
	}

	.block-group > .block-wrapper {
		grid-column: 3;
	}

	.block-group > .block-annotation {
		grid-column: 5;
	}

	/* Sentiment pairing: stack the sentiment card above the scorecard in the
	   content column only. `display: flex` here escapes `display: contents`,
	   so the whole group becomes a single grid item that can declare grid-column.
	   With the grid now spanning the full viewport (not a 1264 container),
	   spanning `1 / -1` would stretch the 3×3 scorecard across 2000+px on
	   wide monitors, so we confine to col 3. */
	.block-group--sentiment-stack {
		display: flex;
		flex-direction: column;
		gap: 16px;
		align-items: stretch;
		grid-column: 3;
		/* Extra breathing room above the Phase C / D conclusion so the body
		   blocks feel closed out before the sentiment card appears. The old
		   layout achieved this with a <Separator /> inside the loop; the new
		   layout places the pair outside the loop, so we lean on margin. */
		margin-top: 16px;
		padding-top: 16px;
		border-top: 1px solid var(--color-border);
	}

	.block-group--sentiment-stack > :global(*) {
		/* Each child takes full width. `min-width: 0` keeps long monospace
		   content inside the scorecard shrinkable rather than forcing
		   horizontal overflow. */
		width: 100%;
		min-width: 0;
	}

	.block-step-number {
		grid-column: 2;
		display: flex;
		align-items: flex-start;
		justify-content: flex-end;
		padding-top: 10px;
		padding-right: 12px;
		font-size: 11px;
		font-family: var(--font-mono, monospace);
		color: var(--color-text-muted);
		opacity: 0.45;
		user-select: none;
		white-space: nowrap;
	}
	.block-step-number--info {
		color: var(--color-accent);
		opacity: 0.75;
	}
	.block-step-number--warning {
		color: var(--color-warning);
		opacity: 0.75;
	}
	.block-step-number--critical {
		color: var(--color-danger);
		opacity: 0.75;
	}

	.block-wrapper {
		/* position: relative so the severity dot (see .step-issue-dot) can sit
		   just outside the block's left edge via `left: -<n>px`. */
		position: relative;
		max-width: 100%;
		animation: block-slide-up 0.65s cubic-bezier(0.22, 0.61, 0.36, 1) both;
		animation-delay: var(--enter-delay, 0ms);
		will-change: opacity, transform, filter;
		scroll-margin-top: 16px;
		border-radius: 8px;
		outline: 2px solid transparent;
		outline-offset: 2px;
		transition: outline-color 200ms ease;
	}

	@keyframes block-pulse {
		0%   { outline-color: var(--color-accent); }
		70%  { outline-color: var(--color-accent); }
		100% { outline-color: transparent; }
	}

	.block-wrapper--highlighted {
		animation: block-pulse 1.6s ease forwards;
	}

	.block-wrapper--no-anim {
		animation: none;
		opacity: 1;
		transform: none;
		filter: none;
	}

	/* ── Annotation rail ─────────────────────────────────────────────────
	   Sits top-aligned beside its block in the grid row. No sticky — CSS
	   sticky has no cross-sibling awareness, so two annotations in adjacent
	   rows will collide at top: 24px during the row-transition (while row N
	   is still partially on screen, row N+1's annotation has already started
	   sticking). Since code/diff blocks are capped at `min(70vh, 640px)` with
	   their own internal overflow, the outer page never scrolls past a single
	   block for long enough to need the annotation pinned — the whole row
	   (block + annotation) scrolls as a unit. */
	.block-annotation {
		align-self: start;
		padding: 4px 0;
		/* Match the block's entrance timing so rail text appears in sync
		   with its block. Paired with the --enter-delay inline style. */
		animation: block-slide-up 0.65s cubic-bezier(0.22, 0.61, 0.36, 1) both;
		animation-delay: var(--enter-delay, 0ms);
	}

	.block-annotation--no-anim {
		animation: none;
		opacity: 1;
		transform: none;
		filter: none;
	}

	.block-annotation-inner {
		/* Outlined card — matches the bordered treatment of the code/diff blocks
		   in the content column, so the rail reads as a balanced peer instead
		   of loose text next to a bordered panel. Uses the same border token
		   the code/diff blocks use (--color-border). */
		background: var(--color-bg-primary);
		border: 1px solid var(--color-border);
		border-radius: 8px;
		padding: 14px 16px;
		font-size: 14px;
		line-height: 1.6;
		color: var(--color-text-secondary);
		/* Allow long identifiers inside inline <code> (e.g. dotted API paths
		   like AuthService.isTokenRevoked(payload.jti)) to break anywhere so
		   they don't overflow the 380px card. `overflow-wrap: anywhere`
		   (rather than `break-word`) contributes to min-content sizing, which
		   keeps the card honest if a future narrower viewport lets grid col 5
		   shrink. */
		overflow-wrap: anywhere;
	}

	.block-annotation-inner :global(p) {
		margin: 0 0 8px;
	}

	.block-annotation-inner :global(p:last-child) {
		margin-bottom: 0;
	}

	.block-annotation-inner :global(code) {
		font-family: var(--font-mono);
		font-size: 12px;
		background: var(--color-bg-tertiary);
		padding: 1px 4px;
		border-radius: 3px;
	}

	.block-annotation-inner :global(strong) {
		color: var(--color-text-primary);
		font-weight: 600;
	}

	/* ── Streaming bottom indicator ──────────────────────────────────── */

	.streaming-bottom {
		display: flex;
		flex-direction: column;
		align-items: center;
		padding: 24px 0;
		gap: 8px;
	}

	.typing-indicator {
		display: flex;
		gap: 4px;
		padding: 8px 14px;
		background: var(--color-bg-secondary);
		border-radius: 9999px;
		border: 1px solid var(--color-border);
	}

	.typing-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--color-accent);
		animation: cursorBounce 1.4s ease-in-out infinite;
	}

	.typing-dot:nth-child(2) {
		animation-delay: 0.16s;
	}

	.typing-dot:nth-child(3) {
		animation-delay: 0.32s;
	}

	.loading-text {
		font-size: 13px;
		color: var(--color-text-muted);
	}

	.loading-subtext {
		font-size: 11px;
		color: var(--color-text-muted);
		opacity: 0.6;
		margin: 0;
	}

	/* ── Scroll-to-bottom pill ──────────────────────────────────────── */

	:global(.scroll-to-bottom) {
		/* Viewport-centred (50vw). Same rationale as `.tabs-float` in
		   AppShell.svelte — anchored to the viewport, not the main-area, so
		   the pill doesn't hop horizontally when the sidebar is toggled or
		   resized. */
		position: fixed;
		bottom: 20px;
		left: 50%;
		transform: translateX(-50%);
		display: flex;
		align-items: center;
		gap: 6px;
		background: var(--color-accent);
		color: var(--color-primary-foreground);
		border: none;
		border-radius: 9999px;
		padding: 6px 14px;
		font-size: 12px;
		font-weight: 500;
		cursor: pointer;
		box-shadow: var(--color-shadow-sm);
		transition: opacity 150ms, transform 100ms var(--ease-out-expo);
		z-index: 10;
	}

	:global(.scroll-to-bottom):hover {
		opacity: 0.9;
	}

	/* ── Error states ────────────────────────────────────────────────── */

	.error-text {
		font-size: 12px;
		color: var(--color-danger);
		white-space: pre-wrap;
		word-break: break-word;
		overflow-y: auto;
		max-height: 200px;
		max-width: 480px;
		width: 100%;
		background: color-mix(in srgb, var(--color-danger) 8%, transparent);
		border: 1px solid color-mix(in srgb, var(--color-danger, #ef4444) 25%, transparent);
		border-radius: 6px;
		padding: 10px 12px;
		margin: 0;
		font-family: var(--font-mono, monospace);
	}

	.error-hint {
		font-size: 12px;
		color: var(--color-text-muted);
		margin: 0;
	}

	.error-inline {
		font-size: 12px;
		color: var(--color-danger, #ef4444);
		margin-top: 8px;
	}

	/* ── Animations ──────────────────────────────────────────────────── */

	@keyframes pulse {
		0%, 100% { opacity: 0.3; }
		50% { opacity: 0.7; }
	}

	@keyframes pulseIcon {
		0%, 100% { opacity: 1; transform: scale(1); }
		50% { opacity: 0.7; transform: scale(1.1); }
	}

	@keyframes fadeIn {
		from {
			opacity: 0;
			transform: translateY(4px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	@keyframes content-enter {
		from {
			transform: translateY(6px);
			filter: blur(3px);
		}
		to {
			transform: translateY(0);
			filter: blur(0);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.block-wrapper,
		.block-annotation,
		.summary-section,
		.issues-section,
		.walkthrough-content,
		.walkthrough-stepper-header {
			animation-duration: 0.01ms !important;
			animation-delay: 0ms !important;
			transition: none !important;
		}
	}

	@keyframes block-slide-up {
		from {
			opacity: 0;
			transform: translateY(10px);
			filter: blur(4px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
			filter: blur(0);
		}
	}

	@keyframes cursorBounce {
		0%, 80%, 100% {
			opacity: 0.3;
			transform: scale(0.8);
		}
		40% {
			opacity: 1;
			transform: scale(1);
		}
	}

	/* ── Clone-in-progress state ────────────────────────────────────── */

	.clone-progress-container {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 10px;
		width: 100%;
		max-width: 320px;
	}

	:global(.clone-progress-bar) {
		width: 100%;
	}

	/* ── Sentiment card ────────────────────────────────────────────────
	   Renders `walkthrough.sentiment` (Phase C markdown) as a distinct
	   accent-tinted card between the diff-step body and the 9-axis
	   scorecard. Styling tokens match the content column's `.summary-text`
	   markdown so inline code / lists / bold read consistently across the
	   walkthrough. :global() is required because renderMarkdown emits its
	   own DOM that isn't scoped to this component. */

	.sentiment-card {
		background: color-mix(in srgb, var(--color-accent) 5%, var(--color-bg-secondary));
		border: 1px solid color-mix(in srgb, var(--color-accent) 20%, transparent);
		border-radius: 10px;
		padding: 16px 20px;
	}

	.sentiment-card-header {
		margin-bottom: 10px;
	}

	.sentiment-card-title {
		font-size: 16px;
		font-weight: 600;
		color: var(--color-text-primary);
		margin: 0;
	}

	.sentiment-card-body {
		font-size: 14px;
		line-height: 1.65;
		color: var(--color-text-secondary);
	}

	.sentiment-card-body :global(p) {
		margin: 0 0 8px;
	}

	.sentiment-card-body :global(p:last-child) {
		margin-bottom: 0;
	}

	.sentiment-card-body :global(code) {
		font-family: var(--font-mono);
		font-size: 12px;
		background: var(--color-bg-tertiary);
		padding: 1px 4px;
		border-radius: 3px;
	}

	.sentiment-card-body :global(strong) {
		color: var(--color-text-primary);
		font-weight: 600;
	}

	.sentiment-card-body :global(ul),
	.sentiment-card-body :global(ol) {
		margin: 4px 0 8px;
		padding-left: 20px;
	}

	.sentiment-card-body :global(li) {
		margin: 2px 0;
	}

	.sentiment-card-body :global(a) {
		color: var(--color-accent);
		text-decoration: underline;
		text-underline-offset: 2px;
	}

	/* ── Narrow-viewport fallback ────────────────────────────────────────
	   Below the 1336px geometric minimum (24 left + 48 + 820 + 40 + 380 +
	   24 right) the side-by-side grid physically can't fit. Collapse to a
	   single centered 860-max column and stack the annotation card directly
	   below its block. Matches at `max-width: 1335px` (inclusive), so V=1336
	   is the first width at which side-by-side activates. */
	@container (max-width: 1335px) {
		/* Collapse the grid: revert to a single centered 860-max column. */
		.walkthrough-content {
			display: block;
			padding: 28px 32px;
			max-width: 860px;
			margin-inline: auto;
		}

		/* Children no longer need explicit column placement. */
		.walkthrough-content > .summary-section,
		.walkthrough-content > .issues-section,
		.walkthrough-content > .streaming-bottom,
		.walkthrough-content > :global([data-slot="separator"]) {
			grid-column: auto;
		}

		/* Collapse the loading / stepper / connect-progress / banner grids to a
		   simple centered 860-max box at narrow viewport. Children stop spanning
		   a specific grid column and just flow normally. */
		.walkthrough-loading,
		.walkthrough-stepper-header,
		.walkthrough-connect-progress,
		.walkthrough-banner {
			display: block;
			width: 100%;
			max-width: 860px;
			padding-left: 32px;
			padding-right: 32px;
			margin-inline: auto;
			box-sizing: border-box;
		}

		.walkthrough-banner > .walkthrough-banner-row {
			grid-column: auto;
		}

		.walkthrough-loading {
			/* Restore the flex-column gap behavior we had before the grid was
			   introduced, so skeleton + status-bar + exploration-feed get the
			   20px vertical spacing back. */
			display: flex;
			flex-direction: column;
			gap: 20px;
			width: 100%;
		}

		.walkthrough-connect-progress {
			/* Preserve the original flex vertical-center behavior for the
			   Progress bar. */
			display: flex;
			align-items: center;
			width: 100%;
		}

		.walkthrough-loading > *,
		.walkthrough-stepper-header > *,
		.walkthrough-connect-progress > * {
			grid-column: auto;
		}

		.blocks {
			display: block;
			grid-column: auto;
		}

		.block-group > .block-wrapper,
		.block-group > .block-annotation {
			grid-column: auto;
		}

		.block-group--sentiment-stack {
			grid-column: auto;
		}

		/* Annotation card stacks directly below its block. Sticky was already
		   removed at the wide layer; here we just give the stacked card a
		   small top margin so it reads as attached-to-but-distinct-from
		   its block. */
		.block-annotation {
			padding: 0;
			margin-top: 10px;
		}
	}
</style>
