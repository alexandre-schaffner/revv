<script lang="ts">
    /*
     * CommentExpandedBody — the content that appears when a file-level
     * comment row is expanded. Each thread renders as a lifted card; the
     * line-range marker + jump button live at the top of the card, then
     * every message stacks with the same avatar + name + relative-time
     * header used by the inline annotation thread. Replies indent with a
     * thin left guide.
     */
    import type { CommentThread, ThreadMessage } from "@revv/shared";
    import { ArrowUpRight } from "@lucide/svelte";
    import { renderMarkdown } from "$lib/utils/markdown";
    import { isHighlighterReady } from "$lib/utils/code-highlight.svelte";
    import { formatRelativeTime } from "$lib/utils/format-relative-time";
    import MessageAvatar from "../MessageAvatar.svelte";

    interface Props {
        threads: readonly CommentThread[];
        getThreadMessages: (threadId: string) => ThreadMessage[];
        onJump?: ((filePath: string, line: number) => void) | undefined;
    }

    let { threads, getThreadMessages, onJump }: Props = $props();

    // Flatten to a render-ready shape so the template doesn't recompute on
    // every iteration. Re-derive when the shiki highlighter becomes ready
    // so fenced code blocks pick up syntax highlighting on second pass.
    const highlighterReady = $derived(isHighlighterReady());
    const renderedThreads = $derived.by(() => {
        void highlighterReady;
        return threads.map((thread) => {
            const messages = getThreadMessages(thread.id);
            return {
                thread,
                messages,
                rendered: messages.map((msg) => ({
                    id: msg.id,
                    html:
                        msg.body.trim().length > 0
                            ? renderMarkdown(msg.body)
                            : "",
                })),
            };
        });
    });
</script>

<div class="expanded-body">
    {#each renderedThreads as entry (entry.thread.id)}
        <div class="thread-block">
            <div class="thread-head">
                <span class="thread-line" aria-label="Line {entry.thread.startLine}">
                    :{entry.thread.startLine}{#if entry.thread.endLine && entry.thread.endLine !== entry.thread.startLine}-{entry.thread.endLine}{/if}
                </span>
                {#if onJump}
                    <button
                        type="button"
                        class="thread-jump"
                        onclick={() => onJump?.(entry.thread.filePath, entry.thread.startLine)}
                        title="Jump to diff line {entry.thread.startLine}"
                    >
                        <span class="thread-jump-label">jump</span>
                        <ArrowUpRight size={11} aria-hidden="true" />
                    </button>
                {/if}
            </div>

            {#if entry.messages.length === 0}
                <p class="empty-thread">no messages yet</p>
            {:else}
                <ol class="turns">
                    {#each entry.messages as msg, i (msg.id)}
                        <li class="turn" class:turn--reply={i > 0}>
                            <div class="turn-head">
                                <MessageAvatar {msg} />
                                <span class="turn-name">{msg.authorName}</span>
                                <time class="turn-time" datetime={msg.createdAt}>
                                    {formatRelativeTime(msg.createdAt)}
                                </time>
                            </div>
                            <div class="turn-body prose">
                                {#if entry.rendered[i]?.html}
                                    {@html entry.rendered[i].html}
                                {:else}
                                    <p class="turn-empty">(empty message)</p>
                                {/if}
                            </div>
                        </li>
                    {/each}
                </ol>
            {/if}
        </div>
    {/each}
</div>

<style>
    .expanded-body {
        display: flex;
        flex-direction: column;
        gap: 10px;
        padding: 12px 16px 16px;
        color: var(--color-text-secondary);
    }

    /* ── Per-thread block ──────────────────────────────────── */

    .thread-block {
        display: flex;
        flex-direction: column;
        gap: 10px;
        background: var(--color-thread-bg);
        border: 1px solid var(--color-border-subtle);
        border-radius: var(--radius-card);
        box-shadow: var(--color-shadow-sm);
        padding: 12px 14px;
    }

    .thread-head {
        display: flex;
        align-items: center;
        gap: 10px;
    }

    .thread-line {
        font-family: var(--font-mono);
        font-size: 11px;
        font-weight: 600;
        color: var(--color-text-muted);
        letter-spacing: 0.02em;
        white-space: nowrap;
    }

    .thread-jump {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 2px 7px;
        border-radius: 4px;
        border: 1px solid color-mix(in srgb, var(--color-accent) 24%, transparent);
        background: color-mix(in srgb, var(--color-accent) 8%, transparent);
        color: var(--color-accent);
        font-family: var(--font-mono);
        font-size: 10.5px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        cursor: pointer;
        transition:
            background var(--duration-snap) var(--ease-soft),
            border-color var(--duration-snap) var(--ease-soft);
    }

    .thread-jump:hover {
        background: color-mix(in srgb, var(--color-accent) 16%, transparent);
        border-color: color-mix(in srgb, var(--color-accent) 40%, transparent);
    }

    .thread-jump:focus-visible {
        outline: 2px solid var(--color-accent);
        outline-offset: 2px;
    }

    .thread-jump-label {
        line-height: 1;
    }

    /* ── Turns ─────────────────────────────────────────────── */

    .turns {
        list-style: none;
        padding: 0;
        margin: 0;
        display: flex;
        flex-direction: column;
        gap: 10px;
    }

    .turn--reply {
        margin-left: 26px;
        padding-left: 12px;
        border-left: 1px solid var(--color-border-subtle);
    }

    .turn-head {
        display: flex;
        align-items: center;
        gap: 8px;
        color: var(--color-text-muted);
    }

    .turn-name {
        color: var(--color-text-primary);
        font-size: 13px;
        font-weight: 500;
    }

    .turn-time {
        color: var(--color-text-muted);
        font-size: 12px;
        font-variant-numeric: tabular-nums;
        margin-left: auto;
    }

    .turn-body {
        font-family: var(--font-sans);
        font-size: 13px;
        line-height: 1.55;
        color: var(--color-text-secondary);
        max-width: 65ch;
        margin-top: 6px;
    }

    .turn-empty {
        margin: 0;
        color: var(--color-text-muted);
        font-style: italic;
    }

    /* Prose overrides — keep paragraphs flush, trim spacing. */
    .turn-body :global(p) {
        margin: 0 0 6px;
    }
    .turn-body :global(p:last-child) {
        margin-bottom: 0;
    }
    .turn-body :global(strong) {
        font-weight: 600;
        color: var(--color-text-primary);
    }
    .turn-body :global(code) {
        font-family: var(--font-mono, ui-monospace, monospace);
        font-size: 0.85em;
        background: color-mix(in srgb, var(--color-text-muted) 12%, transparent);
        padding: 1px 4px;
        border-radius: 3px;
    }
    .turn-body :global(ul),
    .turn-body :global(ol) {
        margin: 4px 0 6px;
        padding-left: 1.25em;
    }
    .turn-body :global(pre) {
        background: var(--color-bg-tertiary);
        padding: 8px 10px;
        border-radius: 4px;
        overflow-x: auto;
        font-size: 12px;
        margin: 6px 0;
    }
    .turn-body :global(pre code) {
        background: transparent;
        padding: 0;
        font-size: inherit;
    }

    .empty-thread {
        margin: 0;
        font-size: 12px;
        color: var(--color-text-muted);
        font-style: italic;
    }
</style>
