<script lang="ts">
	import { onMount, onDestroy, untrack } from 'svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Separator } from '$lib/components/ui/separator';
	import { RefreshCw, ArrowDown, Search, FileText, Brain, CheckCircle, AlertTriangle, Gauge, Loader2 } from '@lucide/svelte';
	import { getDiffThemeType } from '$lib/stores/theme.svelte';
	import { initHighlighter } from '$lib/utils/code-highlight.svelte';
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
} from '$lib/stores/walkthrough.svelte';
	import { getRepositories } from '$lib/stores/prs.svelte';
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
	import RegenerateDialog from './RegenerateDialog.svelte';

	interface Props {
		prId: string;
		scrollRoot?: HTMLElement | undefined;
		isActive?: boolean;
		sidebarOffset?: number;
	}

	let { prId, scrollRoot, isActive = true, sidebarOffset = 0 }: Props = $props();

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
	const ratings = $derived(getRatings());
	const isLiveGeneration = $derived(getIsLiveGeneration());
	const cloneInProgress = $derived(getCloneInProgress());
	const cloneRepoId = $derived(getCloneRepoId());
	const repositories = $derived(getRepositories());

	// ── Elapsed time ────────────────────────────────────────────────────
	let elapsedSeconds = $state(0);
	let elapsedTimer: ReturnType<typeof setInterval> | null = null;
	let walkthroughDebounce: ReturnType<typeof setTimeout> | undefined;
	let destroyed = false;

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

	// ── Phase steps ─────────────────────────────────────────────────────
	// `rating` sits between `writing` and `finishing` — the model writes the
	// narrative, then runs a batched scorecard pass, then wraps up. Without
	// its own phase, 9 back-to-back rate_axis calls look identical to a stall
	// on the "Writing" step.
	const PHASE_ORDER = ['exploring', 'writing', 'rating'] as const;

	const phaseLabels: Record<string, string> = {
		exploring: 'Explore',
		writing: 'Analyze',
		rating: 'Score',
	};

	// Full-sentence status shown beneath the stepper row during streaming.
	// These override the backend phaseMessage in the stepper specifically so we
	// can craft user-facing language (e.g. "Rating the PR…") independently of
	// the terse backend strings ("Scoring the PR across 9 axes...").
	const phaseStatusLabels: Record<string, string> = {
		exploring: 'Exploring the code…',
		writing: 'Analyzing changes…',
		rating: 'Rating the PR…',
	};

	// analyzing happens in the same agent turn as the last exploration step;
	// map it to exploring so the stepper doesn't show a phantom 4th step.
	function normalizePhase(p: string): string {
		if (p === 'connecting' || p === 'analyzing') return 'exploring';
		if (p === 'finishing') return 'writing';
		return p;
	}

	function phaseIndex(p: string): number {
		return PHASE_ORDER.indexOf(normalizePhase(p) as typeof PHASE_ORDER[number]);
	}

	// ── Stepper visibility ──────────────────────────────────────────────
	// Always visible. The stepper gives the user a persistent map of
	// walkthrough phases — useful during streaming (see what's happening now),
	// after completion (reminder of what ran), and even on fresh PRs (preview
	// of what will happen when they kick off a walkthrough). Only suppressed
	// on fatal streamError (see the template guard) since then the phases are
	// meaningless.
	const stepperVisible = $derived(true);

	// "All phases done" needs actual evidence of completion. A fresh PR with
	// no content shouldn't flash all checkmarks just because !isStreaming — so
	// we require that we actually have SOMETHING to show for it.
	const hasWalkthroughContent = $derived(
		summary !== null || blocks.length > 0 || ratings.length > 0
	);
	const allPhasesDone = $derived(!isStreaming && hasWalkthroughContent);

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

	const blocksWithDelay = $derived.by(() => {
		let newInBatch = 0;
		return blocks.map((block) => {
			if (hasBlockAnimated(prId, block.id)) {
				// Already animated in a previous mount — skip animation entirely
				return { block, delay: -1 };
			}
			// New block — assign staggered delay and record it immediately
			const delay = Math.min(newInBatch, STAGGER_CAP) * STAGGER_MS;
			markBlockAnimated(prId, block.id);
			newInBatch += 1;
			return { block, delay };
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
		const idx = blocks.findIndex((b) => b.id === blockId);
		return idx >= 0 ? idx + 1 : null;
	}

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
			if (!hit && !destroyed) {
				walkthroughDebounce = setTimeout(() => {
					streamWalkthrough(prId);
				}, 2000);
			}
		});
	});

	onDestroy(() => {
		destroyed = true;
		if (elapsedTimer) clearInterval(elapsedTimer);
		if (walkthroughDebounce) clearTimeout(walkthroughDebounce);
	});

	// ── Clone-in-progress auto-retry ────────────────────────────────────
	// When the server rejects the walkthrough because the repo is still
	// cloning, watch for the clone to become ready and auto-retry.
	$effect(() => {
		if (!cloneInProgress || !cloneRepoId) return;
		const repo = repositories.find((r) => r.id === cloneRepoId);
		if (repo?.cloneStatus === 'ready') {
			streamWalkthrough(prId);
		}
	});

	// ── Regenerate dialog ───────────────────────────────────────────────
	let regenerateDialogOpen = $state(false);

	function handleRegenerate(): void {
		if (issues.length > 0) {
			regenerateDialogOpen = true;
		} else {
			regenerate(prId);
		}
	}
</script>

<div class="walkthrough">
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
				<div class="phase-stepper">
					{#each PHASE_ORDER as step, i (step)}
						{@const currentIdx = phaseIndex(phase)}
						{@const isActive = i === currentIdx && !allPhasesDone}
						{@const isDone = allPhasesDone || i < currentIdx}
						<div class="phase-step" class:phase-step--active={isActive} class:phase-step--done={isDone}>
							<div class="phase-step-icon">
							{#if isDone}
								<CheckCircle size={14} />
							{:else if step === 'exploring'}
								<Search size={14} />
							{:else if step === 'writing'}
									<Brain size={14} />
								{:else if step === 'rating'}
									<Gauge size={14} />
								{/if}
							</div>
							<span class="phase-step-label">{phaseLabels[step]}</span>
						</div>
						{#if i < PHASE_ORDER.length - 1}
							<div class="phase-connector" class:phase-connector--done={allPhasesDone || i < currentIdx}></div>
						{/if}
					{/each}
				</div>

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
		<Button variant="outline" size="sm" onclick={handleRegenerate}>
			<RefreshCw size={14} />
			Try again
		</Button>
	</div>
	{:else if cloneInProgress && !summary && blocks.length === 0}
		<!-- Clone-in-progress state: show indeterminate progress bar -->
		<div class="walkthrough-empty">
			<div class="clone-progress-container">
				<p class="loading-text">Cloning repository…</p>
				<Progress indeterminate class="clone-progress-bar" />
				<p class="loading-subtext">The walkthrough will start automatically when cloning completes.</p>
			</div>
		</div>
	{:else if blocks.length === 0 && isStreaming}
		<!-- Loading state: skeleton + exploration feed.
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

			<!-- Skeleton placeholder -->
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
	{:else if !summary && !isStreaming && !streamError}
		<!-- Stream ended with no data -->
		<div class="walkthrough-empty">
			<p class="loading-text">No walkthrough data received. The AI may have timed out.</p>
		<Button variant="outline" size="sm" onclick={handleRegenerate}>
			<RefreshCw size={14} />
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
			<p class="summary-text">{summary}</p>
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

			<!-- Blocks -->
			<div class="blocks">
			{#each blocksWithDelay as { block, delay } (block.id)}
				{@const isSentiment =
					block.type === 'markdown' &&
					block.content.trimStart().startsWith('## Overall Sentiment')}
				{@const hasScorecard = isSentiment && ratings.length > 0}

				<!-- Visual break between the walkthrough body and the conclusion
				     (sentiment + scorecard). Only rendered for the sentiment block
				     so the body blocks keep their tight `.blocks` gap rhythm. The
				     global .walkthrough-content Separator rule gives this 28px of
				     vertical breathing room on each side automatically. -->
				{#if isSentiment}
					<Separator />
				{/if}

				<!-- `.block-group` is a transparent wrapper (display: contents) for
				     normal blocks. For the Overall Sentiment block, it flips to a
				     vertical flex container so the scorecard stacks BELOW the
				     sentiment card — the grid is wider than it is tall, so giving
				     it the full content width reads better than cramming it beside
				     the sentiment prose. DOM order matches visual order, which
				     keeps keyboard tab order and screen-reader flow intuitive. -->
				<div class="block-group" class:block-group--sentiment-stack={hasScorecard}>
					<div
						id="step-{block.id}"
						class="block-wrapper"
						class:block-wrapper--no-anim={delay === -1}
						style:--enter-delay="{delay}ms"
					>
						{#if block.type === 'markdown'}
							{#if isSentiment}
								<div class="sentiment-card">
									<WalkthroughMarkdownBlock content={block.content} />
								</div>
							{:else}
								<WalkthroughMarkdownBlock content={block.content} />
							{/if}
						{:else if block.type === 'code'}
							<WalkthroughCodeBlock {block} {themeType} />
						{:else if block.type === 'diff'}
							<WalkthroughDiffBlock {block} {themeType} />
						{/if}
					</div>

					{#if hasScorecard}
						<div class="sentiment-scorecard">
							<WalkthroughRatingsGrid {ratings} {blocks} onJump={jumpToStep} />
						</div>
					{/if}
				</div>
			{/each}
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
		<Button variant="secondary" class="scroll-to-bottom" style="--sidebar-offset: {sidebarOffset}px" onclick={scrollToBottom}>
			<ArrowDown size={14} />
			New content
		</Button>
		{/if}
	{/if}
</div>

<RegenerateDialog
	bind:open={regenerateDialogOpen}
	{issues}
	onconfirm={(kept) => regenerate(prId, kept)}
	oncancel={() => {}}
/>

<style>
	.walkthrough {
		display: flex;
		flex-direction: column;
		background: var(--color-bg-primary);
	}

	.walkthrough-content {
		padding: 28px 32px;
		animation: fadeIn 0.28s cubic-bezier(0.22, 0.61, 0.36, 1) 60ms both;
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

	.walkthrough-empty {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		min-height: 60vh;
		padding: 80px 32px;
		gap: 12px;
	}

	.walkthrough-loading {
		display: flex;
		flex-direction: column;
		padding: 28px 32px;
		gap: 20px;
	}

	/* ── Connect progress bar (shown during 'connecting' phase) ──────── */

	.walkthrough-connect-progress {
		height: 28px;
		display: flex;
		align-items: center;
		padding: 24px 32px 4px;
		overflow: hidden;
	}

	.walkthrough-stepper-header {
		padding: 24px 32px 4px;
		animation: fadeIn 0.3s cubic-bezier(0.22, 0.61, 0.36, 1) both;
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

	/* ── Phase stepper ────────────────────────────────────────────────── */

	.phase-stepper {
		display: flex;
		align-items: center;
		gap: 0;
		padding: 4px 0 8px;
	}

	.phase-step {
		display: flex;
		align-items: center;
		gap: 6px;
		color: var(--color-text-muted);
		opacity: 0.4;
		transition: opacity 0.3s ease, color 0.3s ease;
	}

	.phase-step--active {
		color: var(--color-accent);
		opacity: 1;
	}

.phase-step--done {
    color: var(--color-accent);
    opacity: 1;
}

	.phase-step-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 22px;
		height: 22px;
		flex-shrink: 0;
	}

	.phase-step--active .phase-step-icon {
		animation: pulseIcon 2s ease-in-out infinite;
	}

	.phase-step-label {
		font-size: 11px;
		font-weight: 500;
		letter-spacing: 0.02em;
		white-space: nowrap;
	}

	.phase-connector {
		flex: 1;
		height: 1px;
		background: var(--color-border);
		margin: 0 8px;
		min-width: 16px;
		transition: background 0.3s ease;
	}

	.phase-connector--done {
		background: var(--color-accent);
		opacity: 0.5;
	}

	.phase-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--color-text-muted);
	}

	.phase-dot--active {
		background: var(--color-accent);
		animation: pulse 1.5s ease-in-out infinite;
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
		width: 100%;
		max-width: 520px;
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
		display: flex;
		flex-direction: column;
		gap: 20px;
		margin-top: 20px;
	}

	/* Transparent wrapper for regular blocks — the single child .block-wrapper
	   reads as a direct flex item of .blocks, preserving the original layout. */
	.block-group {
		display: contents;
	}

	/* Sentiment pairing: stack the sentiment card above the scorecard so the
	   grid gets the full content width it needs to read as a 3×3 map. The
	   previous side-by-side layout squeezed the grid into ~half the content
	   width, which made cells cramped and forced the container query to
	   collapse to 2 columns. Stacking restores the natural 3×3 shape. */
	.block-group--sentiment-stack {
		display: flex;
		flex-direction: column;
		gap: 16px;
		align-items: stretch;
	}

	.block-group--sentiment-stack > :global(*) {
		/* Each child takes full width. `min-width: 0` keeps long monospace
		   content inside the scorecard shrinkable rather than forcing
		   horizontal overflow. */
		width: 100%;
		min-width: 0;
	}

	.block-wrapper {
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
		position: fixed;
		bottom: 20px;
		left: 50%;
		transform: translateX(calc(-50% + var(--sidebar-offset, 0px)));
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

	/* ── Sentiment card ──────────────────────────────────────────────── */

	.sentiment-card {
		background: color-mix(in srgb, var(--color-accent) 5%, var(--color-bg-secondary));
		border: 1px solid color-mix(in srgb, var(--color-accent) 20%, transparent);
		border-radius: 10px;
		padding: 16px 20px;
	}
</style>
