<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Separator } from '$lib/components/ui/separator';
	import { RefreshCw, ArrowDown, Search, FileText, Brain, PenTool, CheckCircle } from '@lucide/svelte';
	import { Tooltip, TooltipContent, TooltipTrigger } from '$lib/components/ui/tooltip';
	import { getDiffThemeType } from '$lib/stores/theme.svelte';
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
		streamWalkthrough,
		regenerate,
	} from '$lib/stores/walkthrough.svelte';
	import WalkthroughMarkdownBlock from './WalkthroughMarkdownBlock.svelte';
	import WalkthroughCodeBlock from './WalkthroughCodeBlock.svelte';
	import WalkthroughDiffBlock from './WalkthroughDiffBlock.svelte';

	interface Props {
		prId: string;
	}

	let { prId }: Props = $props();

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

	const riskClasses: Record<string, string> = {
		low: 'risk-badge risk-badge--low',
		medium: 'risk-badge risk-badge--medium',
		high: 'risk-badge risk-badge--high',
	};

	// ── Elapsed time ────────────────────────────────────────────────────
	let elapsedSeconds = $state(0);
	let elapsedTimer: ReturnType<typeof setInterval> | null = null;

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

	// ── Auto-scroll ─────────────────────────────────────────────────────
	let scrollEl: HTMLDivElement | undefined = $state(undefined);
	let userScrolledUp = $state(false);

	function onScroll() {
		if (!scrollEl) return;
		const atBottom = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 50;
		userScrolledUp = !atBottom;
	}

	function scrollToBottom() {
		userScrolledUp = false;
		scrollEl?.scrollTo({ top: scrollEl.scrollHeight, behavior: 'smooth' });
	}

	// Auto-scroll when new blocks arrive — throttled to avoid flooding rAF queue
	let lastAutoScrollTime = 0;
	let autoScrollTimer: ReturnType<typeof setTimeout> | null = null;

	$effect(() => {
		const _ = blocks.length;
		if (userScrolledUp || !scrollEl) return;

		const now = Date.now();
		const elapsed = now - lastAutoScrollTime;

		if (elapsed >= 150) {
			// Enough time has passed — scroll immediately
			lastAutoScrollTime = now;
			scrollEl.scrollTo({ top: scrollEl.scrollHeight, behavior: 'instant' });
		} else {
			// Too soon — schedule a trailing scroll
			if (autoScrollTimer !== null) clearTimeout(autoScrollTimer);
			autoScrollTimer = setTimeout(() => {
				autoScrollTimer = null;
				lastAutoScrollTime = Date.now();
				scrollEl?.scrollTo({ top: scrollEl.scrollHeight, behavior: 'instant' });
			}, 150 - elapsed);
		}
	});

	onMount(() => {
		streamWalkthrough(prId);
	});

	onDestroy(() => {
		if (elapsedTimer) clearInterval(elapsedTimer);
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
				Try again
			</Button>
		</div>
	{:else if summary}
		<!-- Landing page content -->
		<div class="walkthrough-content" bind:this={scrollEl} onscroll={onScroll}>
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
				<div class="summary-actions">
					{#if isStreaming}
						<span class="streaming-indicator">
							<span class="streaming-dots">
								<span class="streaming-dot"></span>
								<span class="streaming-dot"></span>
								<span class="streaming-dot"></span>
							</span>
							{phaseMessage}
						</span>
					{:else}
						<Tooltip>
							<TooltipTrigger>
								{#snippet child({ props })}
									<Button
										{...props}
										variant="ghost"
										size="icon-sm"
										onclick={() => regenerate(prId)}
									>
										<RefreshCw size={14} />
									</Button>
								{/snippet}
							</TooltipTrigger>
							<TooltipContent>Regenerate walkthrough</TooltipContent>
						</Tooltip>
					{/if}
				</div>
			</div>

			<Separator />

			<!-- Blocks -->
			<div class="blocks">
			{#each blocks as block (block.id)}
				<div class="block-wrapper">
					{#if block.type === 'markdown'}
						<WalkthroughMarkdownBlock content={block.content} animateEntrance={isStreaming && block.id === blocks.at(-1)?.id} />
					{:else if block.type === 'code'}
						<WalkthroughCodeBlock {block} {themeType} animateEntrance={isStreaming && block.id === blocks.at(-1)?.id} />
					{:else if block.type === 'diff'}
						<WalkthroughDiffBlock {block} {themeType} animateEntrance={isStreaming && block.id === blocks.at(-1)?.id} />
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
		height: 100%;
		background: var(--color-bg-primary);
		position: relative;
	}

	.walkthrough-content {
		flex: 1;
		overflow-y: auto;
		padding: 28px 32px;
		min-height: 0;
	}

	.walkthrough-empty {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		height: 100%;
		gap: 12px;
	}

	.walkthrough-loading {
		display: flex;
		flex-direction: column;
		padding: 28px 32px;
		gap: 20px;
		height: 100%;
		overflow-y: auto;
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

	/* ── Blocks ──────────────────────────────────────────────────────── */

	.blocks {
		display: flex;
		flex-direction: column;
		gap: 20px;
		margin-top: 20px;
	}

	.block-wrapper {
		max-width: 100%;
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
		position: absolute;
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
