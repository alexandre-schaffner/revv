<script lang="ts">
import { type CommentThread, canUserModifyComment, type ThreadMessage } from "@revv/shared";
import ArrowUpRight from "phosphor-svelte/lib/ArrowUpRight";
import Trash from "phosphor-svelte/lib/Trash";
import Markdown from "$lib/components/markdown/Markdown.svelte";
import { getCurrentUserLogin } from "$lib/stores/auth.svelte";
import { formatRelativeTime } from "$lib/utils/format-relative-time";
import MessageAvatar from "../MessageAvatar.svelte";

interface Props {
  threads: readonly CommentThread[];
  getThreadMessages: (threadId: string) => ThreadMessage[];
  onJump?: ((filePath: string, line: number) => void) | undefined;
  /** Only offered for threads not yet pushed to GitHub (externalCommentId == null). */
  onDiscard?: ((threadId: string) => void) | undefined;
}

let { threads, getThreadMessages, onJump, onDiscard }: Props = $props();
const currentUserLogin = $derived(getCurrentUserLogin());

const threadEntries = $derived(
  threads.map((thread) => ({ thread, messages: getThreadMessages(thread.id) })),
);
</script>

<div class="expanded-body">
    {#each threadEntries as entry (entry.thread.id)}
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
                {#if onDiscard && entry.thread.externalCommentId == null && entry.messages[0] && canUserModifyComment(entry.messages[0], currentUserLogin)}
                    <button
                        type="button"
                        class="thread-discard"
                        onclick={() => onDiscard?.(entry.thread.id)}
                        title="Discard this pending comment"
                    >
                        <Trash size={11} aria-hidden="true" />
                        <span class="thread-discard-label">discard</span>
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
                            {#if msg.body.trim()}
                                <Markdown class="turn-body" source={msg.body} trust="external" density="dense" />
                            {:else}
                                <div class="turn-body prose prose-sm prose-dense">
                                    <p class="turn-empty">(empty message)</p>
                                </div>
                            {/if}
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

    .thread-discard {
        margin-left: auto;
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 2px 7px;
        border-radius: 4px;
        border: 1px solid color-mix(in srgb, var(--color-danger) 24%, transparent);
        background: color-mix(in srgb, var(--color-danger) 8%, transparent);
        color: var(--color-danger);
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

    .thread-discard:hover {
        background: color-mix(in srgb, var(--color-danger) 16%, transparent);
        border-color: color-mix(in srgb, var(--color-danger) 40%, transparent);
    }

    .thread-discard:focus-visible {
        outline: 2px solid var(--color-danger);
        outline-offset: 2px;
    }

    .thread-discard-label {
        line-height: 1;
    }

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

    /* Density + body tone come from `prose prose-sm prose-dense`; this only
       owns the reading measure and offset. */
    .turn :global(.turn-body) {
        max-width: 65ch;
        margin-top: 6px;
    }

    .turn-empty {
        margin: 0;
        color: var(--color-text-muted);
        font-style: italic;
    }


    .empty-thread {
        margin: 0;
        font-size: 12px;
        color: var(--color-text-muted);
        font-style: italic;
    }
</style>
