<script lang="ts">
	import type { CommentThread, ThreadMessage } from '@revv/shared';
	import { Clock, CornerDownLeft } from '@lucide/svelte';
	import AnnotationCommentInput from './AnnotationCommentInput.svelte';
	import MessageAvatar from './MessageAvatar.svelte';
	import { renderMarkdown } from '$lib/utils/markdown';
	import { formatRelativeTime } from '$lib/utils/format-relative-time';

	interface Props {
		thread: CommentThread;
		messages: ThreadMessage[];
		onReply?: () => void;
		onResolve?: () => void;
		onReopen?: () => void;
		onDiscard?: () => void;
		onDiscardReply?: (messageId: string) => void;
		onCollapse?: (() => void) | undefined;
		onApplySuggestion?: (suggestion: string) => void;
		onEditMessage?: (messageId: string, body: string) => void;
		isReplying?: boolean;
		onReplySubmit?: (body: string) => void;
		onReplyDismiss?: () => void;
		isPending?: boolean;
	}

	let { thread, messages, onReply, onResolve, onReopen, onDiscard, onDiscardReply, onCollapse, onApplySuggestion, onEditMessage, isReplying = false, onReplySubmit, onReplyDismiss, isPending = false }: Props = $props();

	const isResolved = $derived(thread.status === 'resolved' || thread.status === 'wont_fix');

	// ── Pending (unsynced) reply detection ────────────────────────────────────
	// A reply is "pending" once submitted but before the sync loop has pushed it
	// to GitHub (externalId still null). While the thread itself is pending
	// (`isPending`), every message is trivially unsynced and the thread-level
	// Discard handles removal, so we only care about non-first messages on a
	// synced thread. The most recent such message is the one a Discard click
	// should reach for (LIFO — undo the last thing the user did).
	const pendingReply = $derived.by((): ThreadMessage | null => {
		if (isPending) return null;
		for (let i = messages.length - 1; i > 0; i--) {
			const m = messages[i];
			if (m && m.externalId === null) return m;
		}
		return null;
	});

	// ── Inline edit state ─────────────────────────────────────────────────────

	let editingMessageId = $state<string | null>(null);
	let editBody = $state('');

	function startEdit(msg: ThreadMessage): void {
		editingMessageId = msg.id;
		editBody = msg.body;
	}

	function saveEdit(): void {
		if (!editingMessageId) return;
		const trimmed = editBody.trim();
		const original = messages.find((m) => m.id === editingMessageId)?.body ?? '';
		if (trimmed && trimmed !== original) {
			onEditMessage?.(editingMessageId, trimmed);
		}
		editingMessageId = null;
	}

	function cancelEdit(): void {
		editingMessageId = null;
	}

	function focusOnMount(node: HTMLTextAreaElement) {
		node.focus();
		node.setSelectionRange(node.value.length, node.value.length);
	}
</script>

<div
	class="annotation-thread"
	style="opacity: {isResolved ? 0.65 : 1};"
>
	{#each messages as msg, i (msg.id)}
		{@const isMsgPending = !isPending && i > 0 && msg.externalId === null}
		<div
			class="message"
			class:message--first={i === 0}
			class:message--reply={i > 0}
			class:message--pending={isMsgPending}
		>
			<div class="msg-header">
				<MessageAvatar {msg} />
				<span class="author">{msg.authorName}</span>
				{#if isMsgPending}
					<span class="msg-pending-badge" title="Not yet synced to GitHub">
						<Clock size={10} aria-hidden="true" />
						Not synced
					</span>
				{/if}
				<span class="timestamp">{formatRelativeTime(msg.createdAt)}</span>
			</div>

			{#if isPending && i === 0}
				{#if editingMessageId === msg.id}
					<div class="msg-edit">
						<textarea
							class="edit-textarea"
							bind:value={editBody}
							onkeydown={(e) => {
								if (e.key === 'Escape') cancelEdit();
								else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) saveEdit();
							}}
							use:focusOnMount
						></textarea>
						<div class="edit-actions">
							<button class="edit-save-btn" onclick={saveEdit} disabled={!editBody.trim()}>Save</button>
							<button class="edit-cancel-btn" onclick={cancelEdit}>Cancel</button>
						</div>
					</div>
				{:else}
					<div
						class="msg-body msg-body--editable prose"
						role="button"
						tabindex="0"
						title="Click to edit"
						onclick={() => startEdit(msg)}
						onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') startEdit(msg); }}
					>{@html renderMarkdown(msg.body)}</div>
				{/if}
			{:else}
				<div class="msg-body prose">{@html renderMarkdown(msg.body)}</div>
			{/if}

			{#if msg.codeSuggestion}				<div class="suggestion-block">
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
		{#if !isResolved && onReply}
			<button
				class="footer-link"
				class:footer-link--active={isReplying}
				onclick={onReply}
			>
				<CornerDownLeft size={12} aria-hidden="true" />
				{isReplying ? 'Cancel' : 'Add reply...'}
			</button>
		{/if}
		{#if isPending && onDiscard}
			<button
				class="footer-link footer-link--danger"
				onclick={onDiscard}
			>Discard</button>
		{:else if pendingReply && !isResolved && onDiscardReply}
			{@const replyId = pendingReply.id}
			<button
				class="footer-link footer-link--danger"
				onclick={() => onDiscardReply?.(replyId)}
				title="Discard your pending reply"
			>Discard</button>
		{:else if isResolved ? onReopen : onResolve}
			<button
				class="footer-link"
				class:footer-link--muted={isResolved}
				onclick={isResolved ? onReopen : onResolve}
			>{isResolved ? 'Reopen' : 'Resolve'}</button>
		{/if}
		{#if onCollapse}
			<button
				class="footer-collapse"
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
		border: 1px solid var(--color-border-subtle);
		border-radius: var(--radius-card);
		box-shadow: var(--color-shadow-sm);
		padding: 12px 14px 10px;
		font-family: var(--font-sans);
		transition: opacity var(--duration-smooth) var(--ease-soft);
	}

	.message {
		padding-bottom: 10px;
	}

	.message:last-of-type {
		padding-bottom: 0;
	}

	.message--reply {
		margin-left: 26px;
		padding-left: 12px;
		border-left: 1px solid var(--color-border-subtle);
	}

	.msg-header {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-bottom: 6px;
	}

	.author {
		font-size: 13px;
		font-weight: 500;
		color: var(--color-text-primary);
	}

	.timestamp {
		font-size: 12px;
		color: var(--color-text-muted);
		margin-left: auto;
	}

	.msg-body {
		font-size: 13px;
		line-height: 1.6;
		color: var(--color-text-secondary);
		word-break: break-word;
	}

	.msg-body :global(p) {
		margin: 0 0 6px;
	}
	.msg-body :global(p:last-child) {
		margin-bottom: 0;
	}
	.msg-body :global(strong) {
		font-weight: 600;
		color: var(--color-text-primary);
	}
	.msg-body :global(em) {
		font-style: italic;
	}
	.msg-body :global(code) {
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 0.85em;
		background: color-mix(in srgb, var(--color-text-muted) 12%, transparent);
		padding: 1px 4px;
		border-radius: 3px;
	}
	.msg-body :global(ul),
	.msg-body :global(ol) {
		margin: 4px 0 6px;
		padding-left: 1.4em;
	}
	.msg-body :global(li) {
		margin-bottom: 2px;
	}
	.msg-body :global(pre) {
		background: var(--color-bg-tertiary);
		padding: 8px 10px;
		border-radius: 4px;
		overflow-x: auto;
		font-size: 12px;
		margin: 6px 0;
	}
	.msg-body :global(pre code) {
		background: transparent;
		padding: 0;
		font-size: inherit;
	}
	.msg-body :global(blockquote) {
		margin: 4px 0;
		padding-left: 10px;
		border-left: 2px solid var(--color-border);
		color: var(--color-text-muted);
	}
	.msg-body :global(a) {
		color: var(--color-accent);
		text-decoration: underline;
		text-underline-offset: 2px;
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
		gap: 12px;
		padding-top: 8px;
	}

	.footer-link {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-family: inherit;
		font-size: 12px;
		background: transparent;
		border: none;
		cursor: pointer;
		padding: 2px 0;
		color: var(--color-accent);
		transition: color var(--duration-snap) var(--ease-soft);
	}

	.footer-link:hover {
		text-decoration: underline;
		text-underline-offset: 2px;
	}

	.footer-link--muted {
		color: var(--color-text-muted);
	}

	.footer-link--muted:hover {
		color: var(--color-text-secondary);
	}

	.footer-link--danger {
		color: var(--color-danger, #ef4444);
	}

	.footer-link--active {
		color: var(--color-text-muted);
	}

	.footer-collapse {
		margin-left: auto;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 2px;
		background: transparent;
		border: none;
		border-radius: 4px;
		cursor: pointer;
		color: var(--color-text-muted);
		transition:
			background-color var(--duration-snap) var(--ease-soft),
			color var(--duration-snap) var(--ease-soft);
	}

	.footer-collapse:hover {
		background: var(--color-bg-tertiary);
		color: var(--color-text-secondary);
	}

	.msg-pending-badge {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		font-size: 9px;
		font-weight: 500;
		color: var(--color-text-muted);
		background: var(--color-bg-tertiary);
		border-radius: 3px;
		padding: 1px 5px;
		opacity: 0.85;
	}

	.message--pending .msg-body {
		opacity: 0.85;
	}

	.msg-body--editable {
		cursor: text;
		border-radius: 3px;
		margin: -2px -4px;
		padding: 2px 4px;
		transition: background-color 80ms;
	}
	.msg-body--editable:hover {
		background: var(--color-bg-tertiary);
	}
	.msg-edit {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.edit-textarea {
		width: 100%;
		min-height: 60px;
		background: var(--color-input-bg);
		border: 1px solid var(--color-accent);
		border-radius: 4px;
		padding: 6px 8px;
		font-family: var(--font-sans);
		font-size: 13px;
		line-height: 1.6;
		color: var(--color-text-primary);
		resize: vertical;
		outline: none;
		box-sizing: border-box;
	}
	.edit-actions {
		display: flex;
		gap: 6px;
		justify-content: flex-end;
	}
	.edit-save-btn {
		font-size: 11px;
		padding: 3px 10px;
		border-radius: 4px;
		border: none;
		background: var(--color-accent);
		color: var(--color-primary-foreground);
		cursor: pointer;
	}
	.edit-save-btn:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.edit-cancel-btn {
		font-size: 11px;
		padding: 3px 10px;
		border-radius: 4px;
		border: 1px solid var(--color-border);
		background: transparent;
		color: var(--color-text-muted);
		cursor: pointer;
	}
	.edit-cancel-btn:hover {
		background: var(--color-bg-tertiary);
	}
</style>
