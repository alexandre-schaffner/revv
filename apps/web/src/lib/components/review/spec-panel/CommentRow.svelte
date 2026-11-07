<script lang="ts">
/*
 * Every unresolved thread on one file, as one row. The file badge jumps to the
 * first thread; each thread in the open body has its own jump.
 */
import type { CommentThread } from "@revv/shared";
import Chat from "phosphor-svelte/lib/Chat";
import Chats from "phosphor-svelte/lib/Chats";
import Avatar from "$lib/components/shared/Avatar.svelte";
import FileBadge from "$lib/components/ui/FileBadge.svelte";
import { enterOnce } from "$lib/motion";
import { lineRangeLabel } from "$lib/review/threads";
import { getThreadMessages } from "$lib/stores/review.svelte";
import { openInDiff } from "$lib/stores/review-nav.svelte";
import CommentExpandedBody from "./CommentExpandedBody.svelte";
import SpecRow from "./SpecRow.svelte";

interface Props {
  prId: string;
  filePath: string;
  /** Ordered by startLine. */
  threads: readonly CommentThread[];
  open: boolean;
  onToggleOpen: () => void;
  onDiscard?: ((threadId: string) => void) | undefined;
  onTriggerRef?: ((el: HTMLElement | null) => void) | undefined;
}

let { prId, filePath, threads, open, onToggleOpen, onDiscard, onTriggerRef }: Props = $props();

// groupThreadsByFile never yields an empty group, but degrade if it ever does.
const firstThread = $derived(threads[0]);
const firstThreadMessages = $derived(firstThread ? getThreadMessages(prId, firstThread.id) : []);
const firstMessage = $derived(firstThreadMessages[0]);
const preview = $derived(firstMessage?.body.trim() ?? "");

const totalMessages = $derived(
  threads.reduce((sum, t) => sum + getThreadMessages(prId, t.id).length, 0),
);
const hasMultipleMessages = $derived(totalMessages > 1);
const hasMultipleThreads = $derived(threads.length > 1);

const motionKey = $derived(`spec-row:comment:${firstThread?.reviewSessionId}:${filePath}`);

const ariaLabel = $derived(
  threads.length === 1 && firstThread
    ? `Comment on ${filePath}:${firstThread.startLine}` +
        (totalMessages > 1 ? `, ${totalMessages} messages` : "")
    : `${threads.length} comment threads on ${filePath}`,
);
</script>

<div
    class="comment-row"
    data-open={open ? "true" : undefined}
    use:enterOnce={{
        key: motionKey,
        look: "row",
        cascade: { group: "comment-rows", step: 0.05, cap: 6 },
    }}
>
    <SpecRow
        {open}
        onToggle={onToggleOpen}
        {motionKey}
        {ariaLabel}
        {onTriggerRef}
    >
        {#snippet icon()}
            <span class="comment-icon" aria-hidden="true">
                {#if hasMultipleMessages || hasMultipleThreads}
                    <Chats size={13} />
                {:else}
                    <Chat size={13} />
                {/if}
            </span>
        {/snippet}

        {#snippet label()}
            <span
                class="file-badge-slot"
                onclick={(e) => e.stopPropagation()}
                role="presentation"
            >
                <FileBadge
                    {filePath}
                    startLine={!hasMultipleThreads && firstThread ? firstThread.startLine : undefined}
                    endLine={!hasMultipleThreads && firstThread ? firstThread.endLine : undefined}
                    onclick={firstThread
                        ? () => openInDiff(prId, filePath, firstThread.startLine)
                        : undefined}
                />
            </span>
            {#if !hasMultipleThreads && firstThread}
                <span class="line-chip" aria-label="Line {firstThread.startLine}">
                    {lineRangeLabel(firstThread)}
                </span>
            {/if}
        {/snippet}

        {#snippet preview()}
            <span class="preview-wrap">
                <span class="preview-avatar" title={firstMessage?.authorName ?? ""}>
                    <Avatar
                        src={firstMessage?.authorRole === 'ai_agent' ? null : firstMessage?.authorAvatarContent}
                        name={firstMessage?.authorName ?? ""}
                        size={14}
                        fallback={firstMessage?.authorRole === 'ai_agent' ? 'robot' : 'user'}
                        glyphSize={11}
                    />
                </span>
                <span class="comment-preview">{preview}</span>
            </span>
        {/snippet}

        {#snippet trailing()}
            {#if hasMultipleThreads}
                <span class="count-pill" title="{threads.length} threads">
                    <span class="count-pill-num">{threads.length}</span>
                    <span class="count-pill-label">threads</span>
                </span>
            {:else if hasMultipleMessages}
                <span class="count-pill" title="{totalMessages} messages">
                    <span class="count-pill-num">{totalMessages}</span>
                    <span class="count-pill-label">msgs</span>
                </span>
            {/if}
        {/snippet}

        {#snippet content()}
            <CommentExpandedBody {prId} {threads} {onDiscard} />
        {/snippet}
    </SpecRow>
</div>

<style>
    .comment-row {
        --c-gutter-color: var(--color-accent);
        --c-row-bg: var(--color-bg-elevated);
        --c-gutter-flash: var(--color-accent);
    }

    /* A local positioning context keeps the absolute gutter on the trigger
       row; otherwise it stretches against .spec-row through the expanded
       body. Issue and rating rows keep their full-height gutter. */
    .comment-row :global(.spec-row-trigger) {
        position: relative;
    }

    .comment-row[data-open="true"] :global(.spec-row-trigger:not(:disabled):not([aria-disabled="true"])) {
        background: color-mix(
            in srgb,
            var(--color-text-primary) 5%,
            transparent
        );
    }

    .comment-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        color: var(--color-accent);
    }

    /* Stops clicks so the badge doesn't also toggle the row. */

    .file-badge-slot {
        display: inline-flex;
        align-items: center;
    }

    .line-chip {
        font-family: var(--font-mono);
        font-size: 11px;
        font-weight: 500;
        color: var(--color-text-muted);
        letter-spacing: 0.02em;
        white-space: nowrap;
        flex-shrink: 0;
    }

    .preview-wrap {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
    }

    .preview-avatar {
        width: 14px;
        height: 14px;
        border-radius: 50%;
        overflow: hidden;
        flex-shrink: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        background: var(--color-bg-elevated);
        color: var(--color-text-muted);
    }

    .comment-preview {
        font-family: var(--font-sans);
        font-size: 12px;
        color: var(--color-text-muted);
    }

    .count-pill {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 1px 7px;
        border-radius: 4px;
        font-family: var(--font-mono);
        font-size: 10.5px;
        font-weight: 600;
        letter-spacing: 0.04em;
        color: var(--color-text-muted);
        background: color-mix(in srgb, var(--color-accent) 8%, transparent);
        border: 1px solid color-mix(in srgb, var(--color-accent) 20%, transparent);
        font-variant-numeric: tabular-nums;
    }

    .count-pill-num {
        color: var(--color-accent);
        font-weight: 700;
    }

    .count-pill-label {
        text-transform: lowercase;
    }
</style>
