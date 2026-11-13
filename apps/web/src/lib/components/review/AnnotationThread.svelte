<script lang="ts">
import {
  type CommentThread,
  canUserModifyComment,
  isThreadResolved,
  type ThreadMessage,
} from "@revv/shared";
import ArrowElbowDownLeft from "phosphor-svelte/lib/ArrowElbowDownLeft";
import Clock from "phosphor-svelte/lib/Clock";
import PaperPlaneTilt from "phosphor-svelte/lib/PaperPlaneTilt";
import type { Attachment } from "svelte/attachments";
import Markdown from "$lib/components/markdown/Markdown.svelte";
import { viewerLoginOnPr } from "$lib/prs/viewer";
import { canDiscardThread } from "$lib/review/threads";
import { formatRelativeTime } from "$lib/utils/format-relative-time";
import AnnotationCommentInput from "./AnnotationCommentInput.svelte";
import MessageAvatar from "./MessageAvatar.svelte";

interface Props {
  prId: string;
  thread: CommentThread;
  messages: readonly ThreadMessage[];
  onReply?: () => void;
  onResolve?: () => void;
  onReopen?: () => void;
  onDiscard?: () => void;
  onDiscardReply?: (messageId: string) => void;
  onEditMessage?: (messageId: string, body: string) => void;
  onPush?: (() => void | Promise<void>) | undefined;
  isReplying?: boolean;
  onReplySubmit?: (body: string) => void;
  onReplyDismiss?: () => void;
  isPending?: boolean;
}

let {
  prId,
  thread,
  messages,
  onReply,
  onResolve,
  onReopen,
  onDiscard,
  onDiscardReply,
  onEditMessage,
  onPush,
  isReplying = false,
  onReplySubmit,
  onReplyDismiss,
  isPending = false,
}: Props = $props();

const isResolved = $derived(isThreadResolved(thread.status));
const viewerLogin = $derived(viewerLoginOnPr(prId));
const canDiscard = $derived(canDiscardThread(thread, messages, viewerLogin));
const canPushThread = $derived(canDiscard && onPush !== undefined);

function canModifyMessage(message: ThreadMessage): boolean {
  return canUserModifyComment(message, viewerLogin);
}

// A reply is pending until the sync loop pushes it to GitHub (externalId still
// null). On a pending thread the thread-level Discard covers every message;
// on a synced one, Discard takes back the latest pending reply.
const pendingReply = $derived.by((): ThreadMessage | null => {
  if (isPending) return null;
  for (let i = messages.length - 1; i > 0; i--) {
    const m = messages[i];
    if (m && canModifyMessage(m)) return m;
  }
  return null;
});

let editingMessageId = $state<string | null>(null);
let editBody = $state("");
let isPushing = $state(false);

function startEdit(msg: ThreadMessage): void {
  editingMessageId = msg.id;
  editBody = msg.body;
}

function saveEdit(): void {
  if (!editingMessageId) return;
  const trimmed = editBody.trim();
  const original = messages.find((m) => m.id === editingMessageId)?.body ?? "";
  if (trimmed && trimmed !== original) {
    onEditMessage?.(editingMessageId, trimmed);
  }
  editingMessageId = null;
}

function cancelEdit(): void {
  editingMessageId = null;
}

async function pushToGitHub(): Promise<void> {
  if (!onPush || isPushing) return;
  isPushing = true;
  try {
    await onPush();
  } finally {
    isPushing = false;
  }
}

const autoSizeEditTextarea: Attachment<HTMLTextAreaElement> = (node) => {
  function resize(): void {
    node.style.height = "auto";
    node.style.height = `${node.scrollHeight}px`;
  }

  resize();
  node.focus({ preventScroll: true });
  node.setSelectionRange(node.value.length, node.value.length);
  node.addEventListener("input", resize);

  return () => node.removeEventListener("input", resize);
};
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

			{#if canModifyMessage(msg)}
				{#if editingMessageId === msg.id}
					<div class="msg-edit">
						<textarea
							class="edit-textarea"
							aria-label="Edit comment"
							bind:value={editBody}
							onkeydown={(e) => {
								if (e.key === 'Escape') cancelEdit();
								else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) saveEdit();
							}}
							{@attach autoSizeEditTextarea}
						></textarea>
						<div class="edit-actions">
							<button class="edit-save-btn" onclick={saveEdit} disabled={!editBody.trim()}>Save</button>
							<button class="edit-cancel-btn" onclick={cancelEdit}>Cancel</button>
						</div>
					</div>
				{:else}
					<Markdown
						class="msg-body msg-body--editable"
						source={msg.body}
						trust="external"
						density="dense"
						role="button"
						tabindex={0}
						title="Click to edit"
						onclick={() => startEdit(msg)}
						onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') startEdit(msg); }}
					/>
				{/if}
			{:else}
				<Markdown class="msg-body" source={msg.body} trust="external" density="dense" />
			{/if}
		</div>
	{/each}

	{#if isReplying && !isResolved}
		<AnnotationCommentInput
			onSubmit={(body) => onReplySubmit?.(body)}
			onDismiss={() => onReplyDismiss?.()}
		/>
	{/if}

	<div class="thread-footer">
		{#if canPushThread}
			<button
				class="footer-link footer-link--send"
				onclick={pushToGitHub}
				disabled={isPushing}
			>
				<PaperPlaneTilt size={12} aria-hidden="true" />
				{isPushing ? 'Sending…' : 'Send to GitHub'}
			</button>
		{/if}
		{#if !isResolved && onReply}
			<button
				class="footer-link"
				class:footer-link--active={isReplying}
				onclick={onReply}
			>
				<ArrowElbowDownLeft size={12} aria-hidden="true" />
				{isReplying ? 'Cancel' : 'Add reply...'}
			</button>
		{/if}
		{#if canDiscard && onDiscard}
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

	.message :global(.msg-body) {
		word-break: break-word;
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

	.footer-link:disabled {
		cursor: default;
		opacity: 0.6;
		text-decoration: none;
	}

	.footer-link--send {
		font-weight: 500;
	}

	.footer-link--muted {
		color: var(--color-text-muted);
	}

	.footer-link--muted:hover {
		color: var(--color-text-secondary);
	}

	.footer-link--danger {
		color: var(--color-danger);
	}

	.footer-link--active {
		color: var(--color-text-muted);
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

	.message--pending :global(.msg-body) {
		opacity: 0.85;
	}

	.message :global(.msg-body--editable) {
		cursor: text;
		border-radius: 3px;
		margin: -2px -4px;
		padding: 2px 4px;
		transition: background-color var(--duration-instant) var(--ease-soft);
	}
	.message :global(.msg-body--editable:hover) {
		background: color-mix(
			in srgb,
			var(--color-bg-tertiary) 55%,
			var(--color-thread-bg)
		);
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
		border: 1px solid var(--color-border);
		border-radius: 4px;
		padding: 6px 8px;
		font-family: var(--font-sans);
		font-size: 13px;
		line-height: 1.6;
		color: var(--color-text-primary);
		resize: none;
		overflow-y: hidden;
		outline: none;
		box-sizing: border-box;
		transition: box-shadow var(--duration-quick) var(--ease-out-expo);
	}
	.edit-textarea:focus-visible {
		box-shadow: 0 0 0 3px var(--color-input-focus-ring);
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
