<script lang="ts">
    /*
     * CommentExpandedBody — the content that appears when a file-level
     * comment row is expanded. Renders every thread in the file stacked
     * vertically, separated by an uppercase-mono "THREADS" hairline so the
     * panel reads like a terminal transcript:
     *
     *     :12-18   [↗ jump]
     *     REVIEWER · 2h ago
     *     First message body…
     *     AUTHOR · 1h ago
     *     Reply body…
     *
     *     ─────── THREADS ───────
     *
     *     :45-50   [↗ jump]
     *     REVIEWER · 40m ago
     *     …
     *
     * Each thread gets a small head row with its line range and an optional
     * jump-to-diff chip; within a thread, messages render as per-turn
     * entries with uppercase-mono author lines and sans-serif prose bodies.
     */
    import type { CommentThread, ThreadMessage } from "@revv/shared";
    import { User, Bot, ArrowUpRight } from "@lucide/svelte";
    import { renderMarkdown } from "$lib/utils/markdown";

    interface Props {
        threads: readonly CommentThread[];
        getThreadMessages: (threadId: string) => ThreadMessage[];
        onJump?: ((filePath: string, line: number) => void) | undefined;
    }

    let { threads, getThreadMessages, onJump }: Props = $props();

    // Per-message avatar load-failure tracking. Reassign via `new Set(...)`
    // so Svelte 5 runes observe the mutation.
    let failedAvatars = $state<Set<string>>(new Set());

    // Flatten to a render-ready shape so the template doesn't recompute on
    // every iteration. `html` is a Promise — marked + highlighter are lazy.
    const renderedThreads = $derived.by(() =>
        threads.map((thread) => {
            const messages = getThreadMessages(thread.id);
            return {
                thread,
                messages,
                rendered: messages.map((msg) => ({
                    id: msg.id,
                    html:
                        msg.body.trim().length > 0
                            ? renderMarkdown(msg.body)
                            : Promise.resolve(""),
                })),
            };
        }),
    );

    const authorLabels: Record<string, string> = {
        reviewer: "REVIEWER",
        coder: "AUTHOR",
        ai_agent: "AI AGENT",
    };

    function formatRelative(iso: string): string {
        const then = Date.parse(iso);
        if (Number.isNaN(then)) return iso;
        const delta = Date.now() - then;
        const sec = Math.round(delta / 1000);
        if (sec < 45) return "just now";
        const min = Math.round(sec / 60);
        if (min < 45) return `${min}m ago`;
        const hr = Math.round(min / 60);
        if (hr < 22) return `${hr}h ago`;
        const day = Math.round(hr / 24);
        if (day < 10) return `${day}d ago`;
        return new Date(then).toISOString().slice(0, 10);
    }
</script>

<div class="expanded-body">
    {#each renderedThreads as entry, threadIdx (entry.thread.id)}
        {#if threadIdx > 0}
            <div class="section-divider section-divider--threads" aria-hidden="true">
                <span class="section-divider-label">threads</span>
            </div>
        {/if}

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
                        <li class="turn">
                            <div class="turn-head">
                                {#if msg.authorRole === 'ai_agent'}
                                    <span class="turn-avatar turn-avatar--icon" aria-hidden="true">
                                        <Bot size={11} />
                                    </span>
                                {:else if msg.authorAvatarUrl && !failedAvatars.has(msg.id)}
                                    <img
                                        src={msg.authorAvatarUrl}
                                        alt={msg.authorName}
                                        class="turn-avatar turn-avatar--img"
                                        loading="lazy"
                                        referrerpolicy="no-referrer"
                                        onerror={() => { failedAvatars = new Set([...failedAvatars, msg.id]); }}
                                    />
                                {:else}
                                    <span class="turn-avatar turn-avatar--icon" aria-hidden="true">
                                        <User size={11} />
                                    </span>
                                {/if}
                                <span class="turn-author">
                                    {authorLabels[msg.authorRole] ?? msg.authorRole.toUpperCase()}
                                </span>
                                <span class="turn-sep" aria-hidden="true">·</span>
                                <span class="turn-name">{msg.authorName}</span>
                                <span class="turn-sep" aria-hidden="true">·</span>
                                <time class="turn-time" datetime={msg.createdAt}>
                                    {formatRelative(msg.createdAt)}
                                </time>
                            </div>
                            <div class="turn-body prose">
                                {#await entry.rendered[i]?.html ?? Promise.resolve("")}
                                    <p class="turn-loading">…</p>
                                {:then html}
                                    {#if html}
                                        {@html html}
                                    {:else}
                                        <p class="turn-empty">(empty message)</p>
                                    {/if}
                                {/await}
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
        gap: 12px;
        padding: 10px 12px 16px;
        padding-left: calc(2ch + 14px);
        font-family: var(--font-mono);
        font-size: 12.5px;
        color: var(--color-text-secondary);
        /* Darker neutral wash — deepens below the accent-tinted trigger so the
           expansion reads as an inset "drawer" under its parent row. Black
           overlay (not --color-text-primary) keeps the direction consistent in
           both themes: panel darkens rather than lightening in dark mode. */
        background: color-mix(in srgb, black 10%, transparent);
    }

    /* ── Per-thread block ──────────────────────────────────── */

    .thread-block {
        display: flex;
        flex-direction: column;
        gap: 10px;
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

    /* ── Section divider — uppercase mono hairline ──────────── */

    .section-divider {
        display: flex;
        align-items: center;
        gap: 8px;
        color: var(--color-text-muted);
        font-family: var(--font-mono);
        font-size: 10.5px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
    }

    .section-divider--threads {
        margin: 4px 0;
    }

    .section-divider::before,
    .section-divider::after {
        content: "";
        flex: 1;
        height: 1px;
        background: var(--color-border);
        opacity: 0.45;
    }

    .section-divider-label {
        flex-shrink: 0;
    }

    /* ── Turns ─────────────────────────────────────────────── */

    .turns {
        list-style: none;
        padding: 0;
        margin: 0;
        display: flex;
        flex-direction: column;
        gap: 12px;
    }

    /* Between-turn hairline — subtle like `git log` separator. */
    .turn + .turn {
        position: relative;
        padding-top: 12px;
    }

    .turn + .turn::before {
        content: "";
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        height: 1px;
        background: var(--color-border);
        opacity: 0.3;
    }

    /* Author line — uppercase mono, muted. Echoes `git log`'s commit-author
       line, with a relative timestamp in place of a hash. */
    .turn-head {
        display: flex;
        align-items: center;
        gap: 8px;
        font-family: var(--font-mono);
        font-size: 10.5px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--color-text-muted);
        flex-wrap: wrap;
    }

    .turn-avatar {
        width: 14px;
        height: 14px;
        border-radius: 50%;
        flex-shrink: 0;
    }

    .turn-avatar--img {
        object-fit: cover;
        display: block;
    }

    .turn-avatar--icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        background: var(--color-bg-elevated);
        color: var(--color-text-muted);
    }

    .turn-author {
        color: var(--color-text-secondary);
        font-weight: 700;
    }

    .turn-sep {
        color: var(--color-text-muted);
        opacity: 0.6;
    }

    .turn-name {
        color: var(--color-text-muted);
        text-transform: none;
        letter-spacing: 0;
        font-weight: 500;
    }

    .turn-time {
        color: var(--color-text-muted);
        font-variant-numeric: tabular-nums;
        letter-spacing: 0;
        text-transform: none;
    }

    .turn-body {
        font-family: var(--font-sans);
        font-size: 13px;
        line-height: 1.55;
        color: var(--color-text-primary);
        max-width: 65ch;
        margin-top: 4px;
    }

    .turn-loading,
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
        font-family: var(--font-mono);
        font-size: 12px;
        color: var(--color-text-muted);
        font-style: italic;
    }
</style>
