<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { fade } from 'svelte/transition';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Separator } from '$lib/components/ui/separator';
	import { RefreshCw, ArrowDown, Search, FileText, Brain, PenTool, CheckCircle, AlertTriangle } from '@lucide/svelte';
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
		streamWalkthrough,
		regenerate,
	} from '$lib/stores/walkthrough.svelte';

	import WalkthroughMarkdownBlock from './WalkthroughMarkdownBlock.svelte';
	import WalkthroughCodeBlock from './WalkthroughCodeBlock.svelte';
	import WalkthroughDiffBlock from './WalkthroughDiffBlock.svelte';

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

	const riskClasses: Record<string, string> = {
		low: 'risk-badge risk-badge--low',
		medium: 'risk-badge risk-badge--medium',
		high: 'risk-badge risk-badge--high',
	};

	const severityClasses: Record<string, string> = {
		info: 'issue-badge issue-badge--info',
		warning: 'issue-badge issue-badge--warning',
		critical: 'issue-badge issue-badge--critical',
	};

	const severityLabels: Record<string, string> = {
		info: 'Info',
		warning: 'Warning',
		critical: 'Critical',
	};

	// ── Elapsed time ────────────────────────────────────────────────────
	let elapsedSeconds = $state(0);
	let elapsedTimer: ReturnType<typeof setInterval> | null = null;
	let walkthroughDebounce: ReturnType<typeof setTimeout> | undefined;

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
	const PHASE_ORDER = ['connecting', 'exploring', 'analyzing', 'writing', 'finishing'] as const;

	const phaseLabels: Record<string, string> = {
		connecting: 'Connect',
		exploring: 'Explore',
		analyzing: 'Analyze',
		writing: 'Write',
		finishing: 'Finish',
	};

	function phaseIndex(p: string): number {
		return PHASE_ORDER.indexOf(p as typeof PHASE_ORDER[number]);
	}

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
	const blockDelays = new Map<string, number>();

	const blocksWithDelay = $derived.by(() => {
		let newInBatch = 0;
		return blocks.map((block) => {
			let delay = blockDelays.get(block.id);
			if (delay === undefined) {
				delay = Math.min(newInBatch, STAGGER_CAP) * STAGGER_MS;
				blockDelays.set(block.id, delay);
				newInBatch += 1;
			}
			return { block, delay };
		});
	});

	onMount(() => {
		initHighlighter();
		walkthroughDebounce = setTimeout(() => {
			streamWalkthrough(prId);
		}, 2000);
	});

	onDestroy(() => {
		if (elapsedTimer) clearInterval(elapsedTimer);
		if (walkthroughDebounce) clearTimeout(walkthroughDebounce);
	});
</script>

<div class="walkthrough">
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
			<Button variant="outline" size="sm" onclick={() => regenerate(prId)}>
				<RefreshCw size={14} />
				Try again
			</Button>
		</div>
	{:else if !summary && isStreaming}
		<!-- Loading state with phase progress -->
		<div class="walkthrough-loading">
			<!-- Phase stepper -->
			<div class="phase-stepper">
				{#each PHASE_ORDER as step, i (step)}
					{@const currentIdx = phaseIndex(phase)}
					{@const isActive = i === currentIdx}
					{@const isDone = i < currentIdx}
					<div class="phase-step" class:phase-step--active={isActive} class:phase-step--done={isDone}>
						<div class="phase-step-icon">
							{#if isDone}
								<CheckCircle size={14} />
							{:else if step === 'connecting'}
								<div class="phase-dot" class:phase-dot--active={isActive}></div>
							{:else if step === 'exploring'}
								<Search size={14} />
							{:else if step === 'analyzing'}
								<Brain size={14} />
							{:else if step === 'writing'}
								<PenTool size={14} />
							{:else}
								<CheckCircle size={14} />
							{/if}
						</div>
						<span class="phase-step-label">{phaseLabels[step]}</span>
					</div>
					{#if i < PHASE_ORDER.length - 1}
						<div class="phase-connector" class:phase-connector--done={i < currentIdx}></div>
					{/if}
				{/each}
			</div>

			<!-- Status message + timer -->
			<div class="status-bar">
				<div class="status-message">
					<div class="status-dot"></div>
					<span>{phaseMessage}</span>
				</div>
				<span class="elapsed-time">{formatElapsed(elapsedSeconds)}</span>
			</div>

			<!-- Skeleton placeholder -->
			<div class="skeleton-body">
				<div class="skeleton-summary">
					<div class="skeleton-badge"></div>
					<div class="skeleton-line" style="width: 95%"></div>
					<div class="skeleton-line" style="width: 80%"></div>
					<div class="skeleton-line" style="width: 50%"></div>
				</div>

				<div class="skeleton-separator"></div>

				<div class="skeleton-card">
					<div class="skeleton-card-body">
						<div class="skeleton-line" style="width: 90%"></div>
						<div class="skeleton-line" style="width: 100%"></div>
						<div class="skeleton-line" style="width: 85%"></div>
						<div class="skeleton-line" style="width: 75%"></div>
						<div class="skeleton-line" style="width: 60%"></div>
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
			<Button variant="outline" size="sm" onclick={() => regenerate(prId)}>
				<RefreshCw size={14} />
				Try again
			</Button>
		</div>
	{:else if summary}
		<!-- Landing page content -->
		<div class="walkthrough-content" in:fade={{ duration: 280, delay: 60 }}>
			<!-- Summary header -->
			<div class="summary-section">
				<div class="summary-header">
					<Badge variant="outline" class={riskClasses[riskLevel] ?? 'risk-badge risk-badge--low'}>
						{riskLevel} risk
					</Badge>
					{#if isStreaming}
						<span class="elapsed-badge">{formatElapsed(elapsedSeconds)}</span>
					{/if}
				</div>
				<p class="summary-text">{summary}</p>
				{#if streamError}
					<p class="error-inline">{streamError}</p>
				{/if}
				{#if isStreaming}
					<div class="summary-actions">
						<span class="streaming-indicator">
							<span class="streaming-dots">
								<span class="streaming-dot"></span>
								<span class="streaming-dot"></span>
								<span class="streaming-dot"></span>
							</span>
							{phaseMessage}
						</span>
					</div>
				{/if}
			</div>

			<Separator />

			<!-- Issues -->
			{#if issues.length > 0}
				<div class="issues-section">
					<div class="issues-header">
						<AlertTriangle size={13} />
						<span>{issues.length} issue{issues.length !== 1 ? 's' : ''} flagged</span>
					</div>
					<div class="issues-list">
						{#each issues as issue, i (issue.id)}
							<div class="issue-item issue-item--{issue.severity}" style:--issue-delay="{Math.min(i, 6) * 50}ms">
								<div class="issue-top">
									<span class={severityClasses[issue.severity] ?? 'issue-badge issue-badge--info'}>
										{severityLabels[issue.severity] ?? issue.severity}
									</span>
									<span class="issue-title">{issue.title}</span>
								</div>
								<p class="issue-description">{issue.description}</p>
								{#if issue.filePath}
									<span class="issue-location">
										{issue.filePath}{issue.startLine != null ? `:${issue.startLine}` : ''}
									</span>
								{/if}
							</div>
						{/each}
					</div>
				</div>
				<Separator />
			{/if}

			<!-- Blocks -->
			<div class="blocks">
			{#each blocksWithDelay as { block, delay } (block.id)}
				<div
					class="block-wrapper"
					style:--enter-delay="{delay}ms"
				>
					{#if block.type === 'markdown'}
						<WalkthroughMarkdownBlock content={block.content} />
					{:else if block.type === 'code'}
						<WalkthroughCodeBlock {block} {themeType} />
					{:else if block.type === 'diff'}
						<WalkthroughDiffBlock {block} {themeType} />
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
		</div>

		<!-- Scroll-to-bottom floating button -->
		{#if userScrolledUp && isStreaming}
			<button class="scroll-to-bottom" onclick={scrollToBottom}>
				<ArrowDown size={14} />
				New content
			</button>
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
		padding: 28px 32px;
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
		color: var(--color-text-secondary);
		opacity: 0.7;
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
		border-radius: 999px;
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

	.skeleton-badge {
		width: 60px;
		height: 22px;
		border-radius: 999px;
		background: var(--color-bg-tertiary);
		position: relative;
		overflow: hidden;
		flex-shrink: 0;
	}

	.skeleton-line {
		height: 14px;
		border-radius: 4px;
		background: var(--color-bg-tertiary);
		position: relative;
		overflow: hidden;
	}

	.skeleton-badge::after,
	.skeleton-line::after {
		content: '';
		position: absolute;
		inset: 0;
		background: linear-gradient(
			90deg,
			transparent 0%,
			color-mix(in srgb, var(--color-text-primary) 6%, transparent) 50%,
			transparent 100%
		);
		transform: translateX(-100%);
		animation: shimmer 1.5s ease-in-out infinite;
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

	.summary-header {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-bottom: 10px;
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

	.streaming-dots {
		display: flex;
		gap: 3px;
	}

	.streaming-dot {
		width: 4px;
		height: 4px;
		border-radius: 50%;
		background: var(--color-accent);
		animation: cursorBounce 1.4s ease-in-out infinite;
	}

	.streaming-dot:nth-child(2) {
		animation-delay: 0.16s;
	}

	.streaming-dot:nth-child(3) {
		animation-delay: 0.32s;
	}

	/* ── Risk badge colors ────────────────────────────────────────────── */

	.summary-header :global(.risk-badge) {
		font-weight: 600;
		text-transform: uppercase;
		font-size: 11px;
		letter-spacing: 0.04em;
	}

	.summary-header :global(.risk-badge--low) {
		background: color-mix(in srgb, #22c55e 12%, transparent);
		color: #15803d;
		border-color: color-mix(in srgb, #22c55e 30%, transparent);
	}

	.summary-header :global(.risk-badge--medium) {
		background: color-mix(in srgb, #f59e0b 12%, transparent);
		color: #b45309;
		border-color: color-mix(in srgb, #f59e0b 30%, transparent);
	}

	.summary-header :global(.risk-badge--high) {
		background: color-mix(in srgb, #ef4444 12%, transparent);
		color: #dc2626;
		border-color: color-mix(in srgb, #ef4444 30%, transparent);
	}

	:global(.dark) .summary-header :global(.risk-badge--low) {
		color: #4ade80;
	}

	:global(.dark) .summary-header :global(.risk-badge--medium) {
		color: #fbbf24;
	}

	:global(.dark) .summary-header :global(.risk-badge--high) {
		color: #f87171;
	}

	/* ── Issues ──────────────────────────────────────────────────────── */

	.issues-section {
		margin-top: 20px;
		margin-bottom: 4px;
		display: flex;
		flex-direction: column;
		gap: 10px;
		animation: content-enter 0.6s cubic-bezier(0.22, 0.61, 0.36, 1) 0.15s both;
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

	.issues-list {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.issue-item {
		padding: 10px 14px;
		border-radius: 8px;
		border-left: 3px solid transparent;
		background: var(--color-bg-secondary);
		border: 1px solid var(--color-border);
		display: flex;
		flex-direction: column;
		gap: 4px;
		animation: content-enter 0.55s cubic-bezier(0.22, 0.61, 0.36, 1) both;
		animation-delay: var(--issue-delay, 0ms);
	}

	.issue-item--info {
		border-left-color: #60a5fa;
	}

	.issue-item--warning {
		border-left-color: #f59e0b;
	}

	.issue-item--critical {
		border-left-color: #ef4444;
		background: color-mix(in srgb, #ef4444 4%, var(--color-bg-secondary));
	}

	.issue-top {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.issue-title {
		font-size: 13px;
		font-weight: 500;
		color: var(--color-text-primary);
	}

	.issue-description {
		font-size: 12px;
		color: var(--color-text-secondary);
		line-height: 1.5;
		margin: 0;
	}

	.issue-location {
		font-size: 11px;
		font-family: var(--font-mono, monospace);
		color: var(--color-text-muted);
		opacity: 0.8;
	}

	.issue-badge {
		font-size: 10px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		padding: 1px 7px;
		border-radius: 999px;
		border: 1px solid transparent;
		flex-shrink: 0;
	}

	.issue-badge--info {
		background: color-mix(in srgb, #60a5fa 12%, transparent);
		color: #2563eb;
		border-color: color-mix(in srgb, #60a5fa 30%, transparent);
	}

	.issue-badge--warning {
		background: color-mix(in srgb, #f59e0b 12%, transparent);
		color: #b45309;
		border-color: color-mix(in srgb, #f59e0b 30%, transparent);
	}

	.issue-badge--critical {
		background: color-mix(in srgb, #ef4444 12%, transparent);
		color: #dc2626;
		border-color: color-mix(in srgb, #ef4444 30%, transparent);
	}

	:global(.dark) .issue-badge--info { color: #93c5fd; }
	:global(.dark) .issue-badge--warning { color: #fbbf24; }
	:global(.dark) .issue-badge--critical { color: #f87171; }

	/* ── Blocks ──────────────────────────────────────────────────────── */

	.blocks {
		display: flex;
		flex-direction: column;
		gap: 20px;
		margin-top: 20px;
	}

	.block-wrapper {
		max-width: 100%;
		animation: block-slide-up 0.65s cubic-bezier(0.22, 0.61, 0.36, 1) both;
		animation-delay: var(--enter-delay, 0ms);
		will-change: opacity, transform, filter;
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
		border-radius: 999px;
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

	.scroll-to-bottom {
		position: fixed;
		bottom: 20px;
		left: 50%;
		transform: translateX(-50%);
		display: flex;
		align-items: center;
		gap: 6px;
		background: var(--color-accent);
		color: white;
		border: none;
		border-radius: 999px;
		padding: 6px 14px;
		font-size: 12px;
		font-weight: 500;
		cursor: pointer;
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
		transition: opacity 150ms;
		z-index: 10;
	}

	.scroll-to-bottom:hover {
		opacity: 0.9;
	}

	/* ── Error states ────────────────────────────────────────────────── */

	.error-text {
		font-size: 12px;
		color: var(--color-danger, #ef4444);
		white-space: pre-wrap;
		word-break: break-word;
		overflow-y: auto;
		max-height: 200px;
		max-width: 480px;
		width: 100%;
		background: color-mix(in srgb, var(--color-danger, #ef4444) 8%, transparent);
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

	@keyframes shimmer {
		0% { transform: translateX(-100%); }
		100% { transform: translateX(100%); }
	}

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
		.issue-item {
			animation-duration: 0.01ms !important;
			animation-delay: 0ms !important;
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
</style>
