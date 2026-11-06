<script lang="ts">
/*
 * Every unresolved thread on one file, as one row:
 *
 *   [chat icon]  src/auth.ts :12   [avatar] first message…   3 threads  ›
 *
 * The file badge jumps to the first thread; each thread in the open body
 * has its own jump.
 */
import type { CommentThread, ThreadMessage } from "@revv/shared";
import Chat from "phosphor-svelte/lib/Chat";
import Chats from "phosphor-svelte/lib/Chats";
import Robot from "phosphor-svelte/lib/Robot";
import User from "phosphor-svelte/lib/User";
import FileBadge from "$lib/components/ui/FileBadge.svelte";
import { enterOnce } from "$lib/motion";
import CommentExpandedBody from "./CommentExpandedBody.svelte";
import SpecRow from "./SpecRow.svelte";

interface Props {
  filePath: string;
  /** Ordered by startLine. */
  threads: readonly CommentThread[];
  getThreadMessages: (threadId: string) => ThreadMessage[];
  open: boolean;
  onToggleOpen: () => void;
  onJump?: ((filePath: string, line: number) => void) | undefined;
  onDiscard?: ((threadId: string) => void) | undefined;
  onTriggerRef?: ((el: HTMLElement | null) => void) | undefined;
}

let {
  filePath,
  threads,
  getThreadMessages,
  open,
  onToggleOpen,
  onJump,
  onDiscard,
  onTriggerRef,
}: Props = $props();

// groupThreadsByFile never yields an empty group, but degrade if it ever does.
const firstThread = $derived(threads[0]);
const firstThreadMessages = $derived(firstThread ? getThreadMessages(firstThread.id) : []);
const firstMessage = $derived(firstThreadMessages[0]);
const preview = $derived(firstMessage?.body.trim() ?? "");

const totalMessages = $derived(threads.reduce((sum, t) => sum + getThreadMessages(t.id).length, 0));
const hasMultipleMessages = $derived(totalMessages > 1);
const hasMultipleThreads = $derived(threads.length > 1);

const motionKey = $derived(`spec-row:comment:${firstThread?.reviewSessionId}:${filePath}`);

let avatarFailed = $state(false);

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
                    onclick={onJump && firstThread
                        ? () => onJump(filePath, firstThread.startLine)
                        : undefined}
                />
            </span>
            {#if !hasMultipleThreads && firstThread}
                <span class="line-chip" aria-label="Line {firstThread.startLine}">
                    :{firstThread.startLine}{#if firstThread.endLine && firstThread.endLine !== firstThread.startLine}-{firstThread.endLine}{/if}
                </span>
            {/if}
        {/snippet}

        {#snippet preview()}
            <span class="preview-wrap">
                <span class="preview-avatar" title={firstMessage?.authorName ?? ""}>
                    {#if firstMessage?.authorRole === 'ai_agent'}
                        <Robot size={11} aria-hidden="true" />
                    {:else if firstMessage?.authorAvatarContent && !avatarFailed}
                        <img
                            src={firstMessage.authorAvatarContent}
                            alt={firstMessage.authorName}
                            class="preview-avatar-img"
                            loading="lazy"
                            referrerpolicy="no-referrer"
                            onerror={() => (avatarFailed = true)}
                        />
                    {:else}
                        <User size={11} aria-hidden="true" />
                    {/if}
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
            <CommentExpandedBody {threads} {getThreadMessages} {onJump} {onDiscard} />
        {/snippet}
    </SpecRow>
</div>

<style>
    .comment-row {
        /* Single neutral-accent gutter — no severity variants for comments. */
        --c-gutter-color: var(--color-accent);
        --c-row-bg: var(--color-bg-elevated);
        --c-gutter-flash: var(--color-accent);
    }

    /* Confine the accent gutter to the clickable trigger row — without a
       local positioning context the gutter (absolute, top/bottom:0) stretches
       against .spec-row and bleeds through the expanded body. Scoped to the
       comments panel so issue/rating rows keep their full-height gutter. */
    .comment-row :global(.spec-row-trigger) {
        position: relative;
    }

    /* Open-trigger tint — neutral wash that marks the row as active without
       slabbing it gray. Kept gentle so the trigger and the drawer below it
       read as one "active region" rather than two stacked gray bars. */
    .comment-row[data-open="true"] :global(.spec-row-trigger:not(:disabled):not([aria-disabled="true"])) {
        background: color-mix(
            in srgb,
            var(--color-text-primary) 5%,
            transparent
        );
    }

    /* ── Icon ──────────────────────────────────────────────── */

    .comment-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        color: var(--color-accent);
    }

    /* ── File-badge slot: stops clicks so the badge doesn't also toggle the row. */

    .file-badge-slot {
        display: inline-flex;
        align-items: center;
    }

    /* ── Line-number chip — mono, muted, like a gutter annotation ── */

    .line-chip {
        font-family: var(--font-mono);
        font-size: 11px;
        font-weight: 500;
        color: var(--color-text-muted);
        letter-spacing: 0.02em;
        white-space: nowrap;
        flex-shrink: 0;
    }

    /* ── Preview (sans for readability) ────────────────────── */

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

    .preview-avatar-img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
    }

    .comment-preview {
        font-family: var(--font-sans);
        font-size: 12px;
        color: var(--color-text-muted);
    }

    /* ── Count pill — mono tabular, git-log-style ──── */

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
