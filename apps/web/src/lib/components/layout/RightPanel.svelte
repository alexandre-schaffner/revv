<script lang="ts">
	import { X, Sparkles, Copy, Settings, RefreshCw, AlertTriangle } from '@lucide/svelte';
	import {
		getActiveExplanation,
		getExplanations,
		getExplanationError,
		setActiveExplanationIdx,
		requestExplanation
	} from '$lib/stores/review.svelte';
	import { renderMarkdown } from '$lib/utils/markdown';

	interface Props {
		onClose: () => void;
		prId?: string;
	}

	let { onClose, prId }: Props = $props();

	const explanation = $derived(getActiveExplanation());
	const history = $derived(getExplanations());
	const isStreaming = $derived(explanation?.isStreaming ?? false);
	const error = $derived(getExplanationError());

	// Rendered markdown (recomputed as content grows during streaming)
	const renderedHtml = $derived(explanation?.content ? renderMarkdown(explanation.content) : '');

	function formatLineRange(range: [number, number]): string {
		if (range[0] === range[1]) return `:${range[0]}`;
		return `:${range[0]}–${range[1]}`;
	}

	function shortPath(filePath: string): string {
		const parts = filePath.split('/');
		return parts.slice(-2).join('/');
	}

	function handleRetry(): void {
		if (!explanation || !prId) return;
		requestExplanation({
			prId,
			filePath: explanation.filePath,
			lineRange: explanation.lineRange,
			codeSnippet: explanation.codeSnippet,
		});
	}
</script>

<div class="panel">
	<!-- Header -->
	<div class="panel-header">
		{#if isStreaming}
			<div class="streaming-dots" aria-label="AI is thinking…">
				<span></span><span></span><span></span>
			</div>
		{:else}
			<span class="panel-title">Context</span>
		{/if}
		<button class="close-btn" onclick={onClose} aria-label="Close panel">
			<X size={14} />
		</button>
	</div>

	<!-- Content -->
	<div class="panel-content">
		{#if !explanation}
			<!-- Empty state -->
			<div class="empty-state">
				<Sparkles size={32} class="empty-icon" />
				<p class="empty-primary">Hover any line and click the sparkle icon for an AI explanation</p>
				<p class="empty-hint">
					Drag the gutter to select a range · <kbd>e</kbd> to explain selection
				</p>
			</div>
		{:else}
			<!-- Breadcrumb -->
			<div class="breadcrumb-bar">
				<div class="breadcrumb-left">
					<span class="breadcrumb-path">{shortPath(explanation.filePath)}</span>
					<span class="breadcrumb-line">{formatLineRange(explanation.lineRange)}</span>
				</div>
				<button class="copy-btn" aria-label="Copy file path" title="Copy path">
					<Copy size={12} />
				</button>
			</div>

			<!-- Code snippet preview -->
			{#if explanation.codeSnippet}
				<div class="code-snippet">
					<code>{explanation.codeSnippet.split('\n').slice(0, 5).join('\n')}</code>
					{#if explanation.codeSnippet.split('\n').length > 5}
						<span class="snippet-more">···</span>
					{/if}
				</div>
			{/if}

			<!-- Error states -->
			{#if error && !isStreaming}
				<div class="error-state">
					{#if error.code === 'NOT_CONFIGURED'}
						<Settings size={24} class="error-icon" />
						<p class="error-primary">AI not configured</p>
						<p class="error-hint">
							Install <a href="https://opencode.ai" class="error-link">OpenCode</a>
							or <a href="https://claude.ai/code" class="error-link">Claude Code</a>
							and authenticate, then select your CLI agent in <a href="/settings" class="error-link">Settings</a>.
						</p>
					{:else if error.code === 'RATE_LIMITED'}
						<AlertTriangle size={24} class="error-icon" />
						<p class="error-primary">Rate limited</p>
						<p class="error-hint">{error.message}</p>
						<button class="retry-btn" onclick={handleRetry}>
							<RefreshCw size={12} />
							Retry
						</button>
					{:else}
						<AlertTriangle size={24} class="error-icon" />
						<p class="error-primary">Explanation failed</p>
						<p class="error-hint">{error.message}</p>
						<button class="retry-btn" onclick={handleRetry}>
							<RefreshCw size={12} />
							Retry
						</button>
					{/if}
				</div>
			{:else if !explanation.content && isStreaming}
				<!-- Skeleton loader -->
				<div class="skeleton-wrap">
					{#each [80, 95, 70, 60] as width}
						<div class="skeleton-line" style="width: {width}%"></div>
					{/each}
				</div>
			{:else}
				<div class="explanation-body">
					{@html renderedHtml}
					{#if isStreaming}
						<span class="stream-cursor" aria-hidden="true"></span>
					{/if}
				</div>
			{/if}
		{/if}
	</div>

	<!-- History strip -->
	{#if history.length > 1}
		<div class="history-strip">
			{#each history as entry, idx}
				<button
					class="history-chip"
					class:history-chip--active={getActiveExplanation() === entry}
					onclick={() => setActiveExplanationIdx(idx)}
					title="{entry.filePath}{formatLineRange(entry.lineRange)}"
				>
					{shortPath(entry.filePath)}{formatLineRange(entry.lineRange)}
				</button>
			{/each}
		</div>
	{/if}
</div>

<style>
	.panel {
		display: flex;
		flex-direction: column;
		height: 100%;
		background: var(--color-panel-bg);
		overflow: hidden;
	}

	/* Header */
	.panel-header {
		height: 40px;
		border-bottom: 1px solid var(--color-border-subtle);
		padding: 0 12px;
		display: flex;
		align-items: center;
		justify-content: space-between;
		flex-shrink: 0;
		position: sticky;
		top: 0;
		z-index: 5;
		background: var(--color-panel-header-bg);
		backdrop-filter: blur(8px);
		-webkit-backdrop-filter: blur(8px);
	}

	.panel-title {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--color-text-muted);
	}

	/* Streaming dots */
	.streaming-dots {
		display: flex;
		align-items: center;
		gap: 4px;
	}

	.streaming-dots span {
		width: 5px;
		height: 5px;
		border-radius: 50%;
		background: var(--color-accent);
		animation: dot-pulse 1.2s ease-in-out infinite;
	}

	.streaming-dots span:nth-child(2) {
		animation-delay: 0.2s;
	}

	.streaming-dots span:nth-child(3) {
		animation-delay: 0.4s;
	}

	@keyframes dot-pulse {
		0%,
		80%,
		100% {
			opacity: 0.3;
			transform: scale(0.8);
		}
		40% {
			opacity: 1;
			transform: scale(1);
		}
	}

	.close-btn {
		width: 24px;
		height: 24px;
		border-radius: 4px;
		border: none;
		background: transparent;
		color: var(--color-text-muted);
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		transition:
			background-color var(--duration-snap),
			color var(--duration-snap);
	}

	.close-btn:hover {
		background: var(--color-bg-tertiary);
		color: var(--color-text-secondary);
	}

	/* Content */
	.panel-content {
		flex: 1;
		overflow-y: auto;
	}

	/* Empty state */
	.empty-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		height: 100%;
		padding: 32px 24px;
		text-align: center;
		gap: 8px;
	}

	:global(.empty-icon) {
		color: var(--color-text-muted);
		margin-bottom: 4px;
	}

	.empty-primary {
		font-size: 13px;
		color: var(--color-text-muted);
		margin: 0;
	}

	.empty-hint {
		font-size: 11px;
		color: var(--color-text-muted);
		margin: 0;
	}

	.empty-hint kbd {
		font-family: var(--font-mono);
		font-size: 10px;
		background: var(--color-bg-tertiary);
		border: 1px solid var(--color-border);
		border-radius: 3px;
		padding: 1px 5px;
		color: var(--color-text-muted);
	}

	/* Breadcrumb bar */
	.breadcrumb-bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 8px 12px;
		border-bottom: 1px solid var(--color-border-subtle);
		background: var(--color-bg-secondary);
	}

	.breadcrumb-left {
		display: flex;
		align-items: center;
		gap: 0;
		min-width: 0;
	}

	.breadcrumb-path {
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--color-tab-inactive-text);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.breadcrumb-line {
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--color-accent);
		font-weight: 600;
		white-space: nowrap;
	}

	.copy-btn {
		width: 20px;
		height: 20px;
		border-radius: 3px;
		border: none;
		background: transparent;
		color: var(--color-text-muted);
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		transition:
			background-color var(--duration-snap),
			color var(--duration-snap);
	}

	.copy-btn:hover {
		color: var(--color-tab-inactive-text);
		background: var(--color-bg-tertiary);
	}

	/* Code snippet */
	.code-snippet {
		margin: 12px 12px 0;
		background: var(--color-diff-bg);
		border-left: 2px solid var(--color-accent);
		border-radius: 4px;
		padding: 8px 10px;
	}

	.code-snippet code {
		font-family: var(--font-mono);
		font-size: 11px;
		line-height: 1.5;
		color: var(--color-text-secondary);
		white-space: pre;
		display: block;
	}

	.snippet-more {
		font-size: 11px;
		color: var(--color-text-muted);
		font-family: var(--font-mono);
		display: block;
		margin-top: 2px;
	}

	/* Skeleton */
	.skeleton-wrap {
		padding: 16px 12px;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.skeleton-line {
		height: 13px;
		border-radius: 3px;
		background: linear-gradient(
			90deg,
			var(--color-bg-tertiary) 25%,
			var(--color-bg-elevated) 50%,
			var(--color-bg-tertiary) 75%
		);
		background-size: 200% 100%;
		animation: shimmer 1.5s infinite;
	}

	/* Error states */
	.error-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		padding: 32px 24px;
		text-align: center;
		gap: 6px;
	}

	:global(.error-icon) {
		color: var(--color-text-muted);
		margin-bottom: 4px;
	}

	.error-primary {
		font-size: 13px;
		font-weight: 500;
		color: var(--color-text-secondary);
		margin: 0;
	}

	.error-hint {
		font-size: 12px;
		color: var(--color-text-muted);
		margin: 0;
	}

	.error-link {
		color: var(--color-accent);
		text-decoration: underline;
		text-underline-offset: 2px;
	}

	.error-link:hover {
		color: var(--color-accent-hover, var(--color-accent));
	}

	.retry-btn {
		display: flex;
		align-items: center;
		gap: 5px;
		margin-top: 8px;
		font-size: 12px;
		font-weight: 500;
		color: var(--color-accent);
		background: color-mix(in srgb, var(--color-ai-accent) 10%, transparent);
		border: none;
		border-radius: 5px;
		padding: 5px 12px;
		cursor: pointer;
		transition: background-color 80ms;
	}

	.retry-btn:hover {
		background: color-mix(in srgb, var(--color-ai-accent) 20%, transparent);
	}

	/* Explanation body — prose styles for rendered markdown HTML */
	.explanation-body {
		padding: 12px;
		font-size: 13px;
		line-height: 1.7;
		color: var(--color-text-primary);
	}

	.explanation-body :global(h2) {
		font-size: 14px;
		font-weight: 600;
		color: var(--color-text-primary);
		margin: 16px 0 6px;
	}

	.explanation-body :global(h3) {
		font-size: 12px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--color-text-secondary);
		margin: 12px 0 4px;
	}

	.explanation-body :global(h4) {
		font-size: 12px;
		font-weight: 600;
		color: var(--color-text-secondary);
		margin: 10px 0 4px;
	}

	.explanation-body :global(p) {
		margin: 4px 0;
		color: var(--color-text-primary);
	}

	.explanation-body :global(ul),
	.explanation-body :global(ol) {
		margin: 4px 0;
		padding-left: 18px;
		color: var(--color-text-primary);
	}

	.explanation-body :global(li) {
		margin: 2px 0;
	}

	.explanation-body :global(hr) {
		border: none;
		border-top: 1px solid var(--color-border-subtle);
		margin: 14px 0;
	}

	.explanation-body :global(strong) {
		font-weight: 600;
		color: var(--color-text-primary);
	}

	.explanation-body :global(code) {
		font-family: var(--font-mono);
		font-size: 11.5px;
		background: var(--color-bg-tertiary);
		border-radius: 3px;
		padding: 1px 4px;
	}

	.explanation-body :global(pre) {
		margin: 8px 0;
		padding: 8px 10px;
		background: var(--color-diff-bg);
		border-radius: 4px;
		overflow-x: auto;
	}

	.explanation-body :global(pre code) {
		background: none;
		padding: 0;
		font-size: 11px;
		line-height: 1.5;
	}

	.explanation-body :global(a) {
		color: var(--color-accent);
		text-decoration: underline;
		text-underline-offset: 2px;
	}

	.explanation-body :global(blockquote) {
		border-left: 2px solid var(--color-border-subtle);
		margin: 8px 0;
		padding: 2px 10px;
		color: var(--color-text-secondary);
	}

	/* Streaming cursor */
	.stream-cursor {
		display: inline-block;
		width: 2px;
		height: 14px;
		background: var(--color-stream-cursor);
		border-radius: 1px;
		margin-left: 1px;
		vertical-align: text-bottom;
		animation: stream-cursor-blink 800ms ease-in-out infinite;
	}

	/* History strip */
	.history-strip {
		height: 36px;
		border-top: 1px solid var(--color-border-subtle);
		background: var(--color-bg-secondary);
		padding: 0 8px;
		display: flex;
		align-items: center;
		gap: 4px;
		overflow-x: auto;
		flex-shrink: 0;
	}

	.history-strip::-webkit-scrollbar {
		height: 3px;
	}

	.history-chip {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--color-text-muted);
		background: var(--color-bg-tertiary);
		border: none;
		border-radius: 4px;
		padding: 2px 7px;
		cursor: pointer;
		white-space: nowrap;
		flex-shrink: 0;
		transition:
			background-color var(--duration-snap),
			color var(--duration-snap);
	}

	.history-chip:hover {
		color: var(--color-text-secondary);
		background: var(--color-bg-elevated);
	}

	.history-chip--active {
		color: var(--color-tree-active-text);
		background: var(--color-tree-active-bg);
	}
</style>
