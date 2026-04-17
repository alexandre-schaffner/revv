<script lang="ts">
	import type { CommentThread, ThreadMessage } from '@revv/shared';
	import AnnotationCommentInput from './AnnotationCommentInput.svelte';

	interface Props {
		thread: CommentThread;
		messages: ThreadMessage[];
		onReply?: () => void;
		onResolve?: () => void;
		onReopen?: () => void;
		onCollapse?: () => void;
		onApplySuggestion?: (suggestion: string) => void;
		isReplying?: boolean;
		onReplySubmit?: (body: string) => void;
		onReplyDismiss?: () => void;
		currentUserRole?: 'reviewer' | 'coder' | 'unknown';
	}

	let { thread, messages, onReply, onResolve, onReopen, onCollapse, onApplySuggestion, isReplying = false, onReplySubmit, onReplyDismiss, currentUserRole = 'unknown' }: Props = $props();

	const isResolved = $derived(thread.status === 'resolved' || thread.status === 'wont_fix');
	const isPending = $derived(
		thread.status === 'pending_coder' || thread.status === 'pending_reviewer'
	);

	const borderColor = $derived(
		isResolved
			? 'var(--color-marker-resolved)'
			: thread.status === 'pending_coder'
				? currentUserRole === 'coder'
					? 'var(--color-marker-your-turn)'
					: 'var(--color-marker-pending)'
				: thread.status === 'pending_reviewer'
					? currentUserRole === 'reviewer'
						? 'var(--color-marker-your-turn)'
						: 'var(--color-marker-pending)'
					: 'var(--color-marker-open)'
	);

	const statusChip = $derived(
		isResolved
			? 'Resolved'
			: thread.status === 'pending_coder'
				? currentUserRole === 'coder'
					? 'Pending you'
					: 'Waiting on coder'
				: thread.status === 'pending_reviewer'
					? currentUserRole === 'reviewer'
						? 'Pending you'
						: 'Waiting on reviewer'
					: null
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

	{#if isReplying && !isResolved}
		<AnnotationCommentInput
			filePath=""
			lineNo={0}
			onSubmit={(body) => onReplySubmit?.(body)}
			onDismiss={() => onReplyDismiss?.()}
		/>
	{/if}

	<div class="thread-footer">
		{#if statusChip}
			<span class="status-chip status-chip--{isResolved ? 'resolved' : 'pending'}">{statusChip}</span>
		{/if}
		{#if !isResolved && onReply}
			<button class="footer-btn footer-btn--reply" class:footer-btn--reply-active={isReplying} onclick={onReply}>
				<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<polyline points="9 17 4 12 9 7" />
					<path d="M20 18v-2a4 4 0 0 0-4-4H4" />
				</svg>
				{isReplying ? 'Cancel' : 'Reply'}
			</button>
		{/if}
		{#if isResolved ? onReopen : onResolve}
			<button
				class="footer-btn"
				class:footer-btn--resolve={!isResolved}
				class:footer-btn--reopen={isResolved}
				onclick={isResolved ? onReopen : onResolve}
			>{isResolved ? 'Reopen' : 'Resolve'}</button>
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
		background: var(--color-thread-bg);
		border-top: 1px solid var(--color-border-subtle);
		border-bottom: 1px solid var(--color-border-subtle);
		border-left: 2px solid transparent;
		padding: 10px 14px 8px;
		font-family: var(--font-sans);
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
		background: var(--color-bg-elevated);
		display: flex;
		align-items: center;
		justify-content: center;
		overflow: hidden;
		flex-shrink: 0;
	}

	.avatar span {
		font-size: 9px;
		font-weight: 600;
		color: var(--color-text-muted);
	}

	.author {
		font-size: 12px;
		font-weight: 500;
		color: var(--color-text-primary);
	}

	.role-badge {
		font-size: 9px;
		font-weight: 600;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		background: var(--color-bg-tertiary);
		color: var(--color-tab-inactive-text);
		border-radius: 3px;
		padding: 1px 5px;
	}

	.timestamp {
		font-size: 11px;
		color: var(--color-text-muted);
		margin-left: auto;
	}

	.msg-body {
		font-size: 13px;
		line-height: 1.6;
		color: var(--color-text-secondary);
		white-space: pre-wrap;
		word-break: break-word;
	}

	.suggestion-block {
		margin-top: 8px;
		border: 1px solid var(--color-border-subtle);
		border-radius: 5px;
		overflow: hidden;
	}

	.suggestion-label {
		display: flex;
		align-items: center;
		gap: 5px;
		padding: 5px 9px;
		font-size: 11px;
		color: var(--color-text-muted);
		background: var(--color-diff-bg);
		border-bottom: 1px solid var(--color-border-subtle);
	}

	.suggestion-code {
		margin: 0;
		padding: 8px 12px;
		font-family: var(--font-mono);
		font-size: 11px;
		line-height: 1.6;
		color: var(--color-text-secondary);
		background: var(--color-diff-bg);
		overflow-x: auto;
		white-space: pre;
	}

	.apply-btn {
		display: block;
		width: 100%;
		padding: 5px 9px;
		font-size: 11px;
		color: var(--color-success);
		background: color-mix(in srgb, var(--color-success) 8%, transparent);
		border: none;
		border-top: 1px solid color-mix(in srgb, var(--color-success) 12%, transparent);
		cursor: pointer;
		text-align: left;
		transition: background-color 80ms;
	}

	.apply-btn:hover {
		background: color-mix(in srgb, var(--color-success) 14%, transparent);
	}

	.thread-footer {
		display: flex;
		align-items: center;
		gap: 6px;
		padding-top: 8px;
		border-top: 1px solid var(--color-border-subtle);
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
		color: var(--color-text-muted);
	}

	.footer-btn:hover {
		background: var(--color-bg-tertiary);
		color: var(--color-text-secondary);
	}

	.footer-btn--resolve {
		color: var(--color-success);
		background: color-mix(in srgb, var(--color-success) 8%, transparent);
		border: 1px solid color-mix(in srgb, var(--color-success) 12%, transparent);
	}

	.footer-btn--resolve:hover {
		background: color-mix(in srgb, var(--color-success) 14%, transparent);
	}

	.footer-btn--collapse {
		margin-left: auto;
	}

	.footer-btn--reply-active {
		color: var(--color-text-secondary);
		background: var(--color-bg-tertiary);
	}

	.footer-btn--reopen {
		color: var(--color-text-muted);
		border: 1px solid var(--color-border-subtle);
	}

	.footer-btn--reopen:hover {
		color: var(--color-text-secondary);
		background: var(--color-bg-tertiary);
		border-color: var(--color-border);
	}

	.status-chip {
		font-size: 10px;
		font-weight: 500;
		padding: 2px 7px;
		border-radius: 10px;
		line-height: 1.4;
	}
	.status-chip--resolved {
		background: color-mix(in srgb, var(--color-marker-resolved) 15%, transparent);
		color: var(--color-text-muted);
	}
	.status-chip--pending {
		background: color-mix(in srgb, var(--color-marker-your-turn, var(--color-marker-pending)) 15%, transparent);
		color: var(--color-marker-your-turn, var(--color-marker-pending));
	}
</style>
