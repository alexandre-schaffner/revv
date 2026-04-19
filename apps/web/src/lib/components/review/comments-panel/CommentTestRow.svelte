<script lang="ts">
    /*
     * CommentTestRow — one unresolved-comment row, keyed by file. Groups all
     * threads on the same file into a single collapsible line:
     *
     *   💬  src/auth.ts   First thread's first message preview…   3 threads  ›
     *   │   │             │                                       │
     *   │   │             └ preview (sans 12 muted, truncated)    └ thread-count pill
     *   │   └ FileBadge — the row's "headline" is the file
     *   └ MessageSquare / MessagesSquare icon (multi-turn signal)
     *
     * Click expands to reveal every thread in the file, separated by the
     * "THREADS" hairline (rendered inside CommentExpandedBody). Jumping to
     * the diff happens either via the FileBadge (jumps to the first thread)
     * or the per-thread `jump` chip inside the expanded body.
     */
    import { MessageSquare, MessagesSquare, User, Bot } from "@lucide/svelte";
    import type { CommentThread, ThreadMessage } from "@revv/shared";
    import FileBadge from "$lib/components/ui/FileBadge.svelte";
    import SpecRow from "../shared/SpecRow.svelte";
    import CommentExpandedBody from "./CommentExpandedBody.svelte";

    interface Props {
        filePath: string;
        /** All threads for this file, ordered by startLine ascending. */
        threads: readonly CommentThread[];
        /** Resolver — called per thread to load its messages. */
        getThreadMessages: (threadId: string) => ThreadMessage[];
        open: boolean;
        index: number;
        onToggleOpen: () => void;
        onJump?: ((filePath: string, line: number) => void) | undefined;
        onTriggerRef?: ((el: HTMLElement | null) => void) | undefined;
    }

    let {
        filePath,
        threads,
        getThreadMessages,
        open,
        index,
        onToggleOpen,
        onJump,
        onTriggerRef,
    }: Props = $props();

    let triggerRef = $state<HTMLElement | null>(null);

    $effect(() => {
        onTriggerRef?.(triggerRef);
        return () => onTriggerRef?.(null);
    });

    // First thread drives the preview + badge line info. Groups are
    // guaranteed non-empty by the caller (groupThreadsByFile skips empty
    // buckets), but guard anyway so the component degrades sensibly if
    // that contract ever slips.
    const firstThread = $derived(threads[0]);
    const firstThreadMessages = $derived(
        firstThread ? getThreadMessages(firstThread.id) : [],
    );
    const firstMessage = $derived(firstThreadMessages[0]);
    const preview = $derived(firstMessage?.body.trim() ?? "");

    // Total messages across all threads drives the icon choice — if the
    // whole file has only one turn we show the single-message glyph, else
    // the multi-turn one.
    const totalMessages = $derived(
        threads.reduce((sum, t) => sum + getThreadMessages(t.id).length, 0),
    );
    const hasMultipleMessages = $derived(totalMessages > 1);
    const hasMultipleThreads = $derived(threads.length > 1);

    const delay = $derived(`${Math.min(index, 6) * 50}ms`);

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
    style:--issue-delay={delay}
    data-open={open ? "true" : undefined}
>
    <SpecRow
        {open}
        onToggle={onToggleOpen}
        state="resolved"
        {ariaLabel}
        dataKind="comment"
        bind:triggerRef
    >
        {#snippet icon()}
            <span class="comment-icon" aria-hidden="true">
                {#if hasMultipleMessages || hasMultipleThreads}
                    <MessagesSquare size={13} />
                {:else}
                    <MessageSquare size={13} />
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
                        <Bot size={11} aria-hidden="true" />
                    {:else if firstMessage?.authorAvatarUrl && !avatarFailed}
                        <img
                            src={firstMessage.authorAvatarUrl}
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
            <CommentExpandedBody {threads} {getThreadMessages} {onJump} />
        {/snippet}
    </SpecRow>
</div>

<style>
    .comment-row {
        /* Single neutral-accent gutter — no severity variants for comments. */
        --c-gutter-color: var(--color-accent);
        --c-row-bg: var(--color-bg-elevated);
        --c-gutter-flash: var(--color-accent);

        animation: comment-row-enter 0.5s var(--ease-out-expo) both;
        animation-delay: var(--issue-delay, 0ms);
    }

    /* Confine the accent gutter to the clickable trigger row — without a
       local positioning context the gutter (absolute, top/bottom:0) stretches
       against .spec-row and bleeds through the expanded body. Scoped to the
       comments panel so issue/rating rows keep their full-height gutter. */
    .comment-row :global(.spec-row-trigger) {
        position: relative;
    }

    /* Open-trigger tint — neutral wash, one step stronger than the body below
       so the header still reads as the clicked/active row. */
    .comment-row[data-open="true"] :global(.spec-row-trigger:not(:disabled):not([aria-disabled="true"])) {
        background: color-mix(
            in srgb,
            var(--color-text-primary) 8%,
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

    /* ── File-badge slot — stop click propagation so the badge
       hover/chip doesn't also toggle the row. ─────────────── */

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

    /* ── Entry animation ───────────────────────────────────── */

    @keyframes comment-row-enter {
        from {
            opacity: 0;
            transform: translateY(4px);
        }
        to {
            opacity: 1;
            transform: translateY(0);
        }
    }

    @media (prefers-reduced-motion: reduce) {
        .comment-row {
            animation: none;
        }
    }
</style>
