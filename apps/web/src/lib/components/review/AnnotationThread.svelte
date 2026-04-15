<script lang="ts">
	import type { CommentThread, ThreadMessage } from '$lib/types/review';

	interface Props {
		thread: CommentThread;
		messages: ThreadMessage[];
		onReply?: () => void;
		onResolve?: () => void;
		onCollapse?: () => void;
		onApplySuggestion?: (suggestion: string) => void;
	}

	let { thread, messages, onReply, onResolve, onCollapse, onApplySuggestion }: Props = $props();

	const isResolved = $derived(thread.status === 'resolved' || thread.status === 'wont_fix');
	const isPending = $derived(
		thread.status === 'pending_coder' || thread.status === 'pending_reviewer'
	);

	const borderColor = $derived(
		isResolved
			? 'var(--color-marker-resolved, #3f3f46)'
			: isPending
				? 'var(--color-marker-pending, #f59e0b)'
				: 'var(--color-marker-open, #3b82f6)'
	);

	function formatTime(iso: string): string {
		const d = new Date(iso);
		const now = new Date();
		const diff = now.getTime() - d.getTime();
		const mins = Math.floor(diff / 60000);
		const hrs = Math.floor(mins / 60);
		const days = Math.floor(hrs / 24);
		if (mins < 1) return 'just now';
		if (mins < 60) return `${mins}m ago`;
		if (hrs < 24) return `${hrs}h ago`;
		return `${days}d ago`;
	}
</script>

<div
	class="annotation-thread"
	style="border-left-color: {borderColor}; opacity: {isResolved ? 0.65 : 1};"
>
	{#each messages as msg, i (msg.id)}
		<div class="message" class:message--first={i === 0}>
			<div class="msg-header">
				<div class="avatar">
					<span>{msg.authorName[0]?.toUpperCase() ?? '?'}</span>
				</div>
				<span class="author">{msg.authorName}</span>
				{#if msg.authorRole !== 'reviewer'}
					<span class="role-badge">{msg.authorRole === 'ai_agent' ? 'AI' : 'Coder'}</span>
				{/if}
				<span class="timestamp">{formatTime(msg.createdAt)}</span>
			</div>

			<div class="msg-body">{msg.body}</div>

			{#if msg.codeSuggestion}
				<div class="suggestion-block">
					<div class="suggestion-label">
						<svg
							width="11"
							height="11"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
						>
							<rect width="10" height="10" x="2" y="2" rx="2" />
							<path d="m7 13 3 3 7-7" />
						</svg>
						Code suggestion
					</div>
					<pre class="suggestion-code">{msg.codeSuggestion}</pre>
					{#if !isResolved && onApplySuggestion && msg.codeSuggestion}
						{@const suggestion = msg.codeSuggestion}
						<button class="apply-btn" onclick={() => onApplySuggestion?.(suggestion)}>
							Apply suggestion
						</button>
					{/if}
				</div>
			{/if}
		</div>
	{/each}

	<div class="thread-footer">
		{#if !isResolved}
			{#if onReply}
				<button class="footer-btn footer-btn--reply" onclick={onReply}>
					<svg
						width="11"
						height="11"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
					>
						<polyline points="9 17 4 12 9 7" />
						<path d="M20 18v-2a4 4 0 0 0-4-4H4" />
					</svg>
					Reply
				</button>
			{/if}
			{#if onResolve}
				<button class="footer-btn footer-btn--resolve" onclick={onResolve}>Resolve</button>
			{/if}
		{:else}
			<span class="resolved-label">Resolved</span>
		{/if}
		{#if onCollapse}
			<button
				class="footer-btn footer-btn--collapse"
				onclick={onCollapse}
				aria-label="Collapse thread"
			>
				<svg
					width="13"
					height="13"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
				>
					<polyline points="18 15 12 9 6 15" />
				</svg>
			</button>
		{/if}
	</div>
</div>

<style>
	.annotation-thread {
		background: var(--color-thread-bg, #1a1a1f);
		border-top: 1px solid var(--color-border-subtle, #2a2a32);
		border-bottom: 1px solid var(--color-border-subtle, #2a2a32);
		border-left: 2px solid transparent;
		padding: 10px 14px 8px;
		font-family: var(--font-sans, system-ui, sans-serif);
		transition: opacity 400ms;
	}

	.message {
		padding-bottom: 8px;
	}

	.msg-header {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-bottom: 5px;
	}

	.avatar {
		width: 18px;
		height: 18px;
		border-radius: 50%;
		background: var(--color-bg-elevated, #2a2a32);
		display: flex;
		align-items: center;
		justify-content: center;
		overflow: hidden;
		flex-shrink: 0;
	}

	.avatar span {
		font-size: 9px;
		font-weight: 600;
		color: var(--color-text-muted, #888);
	}

	.author {
		font-size: 12px;
		font-weight: 500;
		color: var(--color-text-primary, #e4e4e7);
	}

	.role-badge {
		font-size: 9px;
		font-weight: 600;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		background: var(--color-bg-tertiary, #2a2a32);
		color: var(--color-tab-inactive-text, #999);
		border-radius: 3px;
		padding: 1px 5px;
	}

	.timestamp {
		font-size: 11px;
		color: var(--color-text-muted, #888);
		margin-left: auto;
	}

	.msg-body {
		font-size: 13px;
		line-height: 1.6;
		color: var(--color-text-secondary, #c4c4c8);
		white-space: pre-wrap;
		word-break: break-word;
	}

	.suggestion-block {
		margin-top: 8px;
		border: 1px solid var(--color-border-subtle, #2a2a32);
		border-radius: 5px;
		overflow: hidden;
	}

	.suggestion-label {
		display: flex;
		align-items: center;
		gap: 5px;
		padding: 5px 9px;
		font-size: 11px;
		color: var(--color-text-muted, #888);
		background: var(--color-diff-bg, #0d0d10);
		border-bottom: 1px solid var(--color-border-subtle, #2a2a32);
	}

	.suggestion-code {
		margin: 0;
		padding: 8px 12px;
		font-family: var(--font-mono, monospace);
		font-size: 11px;
		line-height: 1.6;
		color: var(--color-text-secondary, #c4c4c8);
		background: var(--color-diff-bg, #0d0d10);
		overflow-x: auto;
		white-space: pre;
	}

	.apply-btn {
		display: block;
		width: 100%;
		padding: 5px 9px;
		font-size: 11px;
		color: var(--color-success, #22c55e);
		background: rgba(34, 197, 94, 0.08);
		border: none;
		border-top: 1px solid rgba(34, 197, 94, 0.12);
		cursor: pointer;
		text-align: left;
		transition: background-color 80ms;
	}

	.apply-btn:hover {
		background: rgba(34, 197, 94, 0.14);
	}

	.thread-footer {
		display: flex;
		align-items: center;
		gap: 6px;
		padding-top: 8px;
		border-top: 1px solid var(--color-border-subtle, #2a2a32);
	}

	.footer-btn {
		display: flex;
		align-items: center;
		gap: 4px;
		font-size: 11px;
		background: transparent;
		border: none;
		cursor: pointer;
		padding: 2px 6px;
		border-radius: 4px;
		transition:
			background-color 80ms,
			color 80ms;
		color: var(--color-text-muted, #888);
	}

	.footer-btn:hover {
		background: var(--color-bg-tertiary, #2a2a32);
		color: var(--color-text-secondary, #c4c4c8);
	}

	.footer-btn--resolve {
		color: var(--color-success, #22c55e);
		background: rgba(34, 197, 94, 0.08);
		border: 1px solid rgba(34, 197, 94, 0.12);
	}

	.footer-btn--resolve:hover {
		background: rgba(34, 197, 94, 0.14);
	}

	.footer-btn--collapse {
		margin-left: auto;
	}

	.resolved-label {
		font-size: 11px;
		color: var(--color-text-muted, #888);
		background: var(--color-bg-tertiary, #2a2a32);
		border-radius: 4px;
		padding: 2px 8px;
	}
</style>
