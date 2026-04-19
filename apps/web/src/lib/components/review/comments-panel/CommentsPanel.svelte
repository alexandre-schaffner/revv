<script lang="ts">
    /*
     * CommentsPanel — orchestrates the unresolved-comment list in the
     * Request Changes tab. One collapsible row per file; the expanded
     * body enumerates all threads on that file with "THREADS" dividers.
     *
     * Keyboard navigation operates over the file rows (keyed by filePath),
     * not individual threads.
     */
    import type { CommentThread, ThreadMessage } from "@revv/shared";
    import { groupThreadsByFile } from "$lib/utils/group-threads";
    import CommentSummaryBar from "./CommentSummaryBar.svelte";
    import CommentTestRow from "./CommentTestRow.svelte";

    interface Props {
        threads: readonly CommentThread[];
        getThreadMessages: (threadId: string) => ThreadMessage[];
        onJump: (filePath: string, line: number) => void;
    }

    let {
        threads,
        getThreadMessages,
        onJump,
    }: Props = $props();

    // ── Filter state ─────────────────────────────────────────

    let onlyWithReplies = $state(false);

    const threadsWithReplies = $derived(threads.filter((t) => (getThreadMessages(t.id)?.length ?? 0) > 1));

    const visibleThreads = $derived(
        threads.filter((t) => {
            if (onlyWithReplies && (getThreadMessages(t.id)?.length ?? 0) <= 1) return false;
            return true;
        }),
    );

    // Group visible threads by file — alphabetical by path, startLine-ordered
    // within each group. Each group renders as a single row; keyboard nav
    // walks groups (files), not individual threads.
    const visibleGroups = $derived(groupThreadsByFile(visibleThreads));

    const counts = $derived({
        unresolved: threads.length,
        withReplies: threadsWithReplies.length,
    });

    function toggleOnlyWithReplies(): void {
        onlyWithReplies = !onlyWithReplies;
    }

    // ── Expand / collapse state (tri-state, same pattern as Issues) ──
    // Keyed by filePath now that rows are per-file.

    let expandAll = $state<boolean | null>(true);
    let rowOpen = $state<Record<string, boolean>>({});

    function isRowOpen(filePath: string): boolean {
        if (expandAll !== null) return expandAll;
        return rowOpen[filePath] ?? false;
    }

    function toggleRow(filePath: string): void {
        if (expandAll !== null) {
            const snapshot: Record<string, boolean> = {};
            for (const g of visibleGroups) snapshot[g.filePath] = expandAll;
            snapshot[filePath] = !expandAll;
            rowOpen = snapshot;
            expandAll = null;
            return;
        }
        rowOpen = { ...rowOpen, [filePath]: !(rowOpen[filePath] ?? false) };
    }

    function toggleExpandAll(): void {
        const anyOpen =
            expandAll === true || visibleGroups.some((g) => rowOpen[g.filePath] === true);
        expandAll = anyOpen ? false : true;
        rowOpen = {};
    }

    // ── Keyboard navigation ──────────────────────────────────

    const rowRefs = new Map<string, HTMLElement | null>();

    function setRowRef(filePath: string, el: HTMLElement | null): void {
        if (el) rowRefs.set(filePath, el);
        else rowRefs.delete(filePath);
    }

    function focusRow(filePath: string): void {
        const el = rowRefs.get(filePath);
        if (el) el.focus();
    }

    function onPanelKeydown(e: KeyboardEvent): void {
        const target = e.target as HTMLElement | null;
        const inInput =
            target?.tagName === "INPUT" ||
            target?.tagName === "TEXTAREA" ||
            target?.isContentEditable;
        if (inInput) return;

        if (e.key === "e" && !e.metaKey && !e.ctrlKey && !e.altKey) {
            e.preventDefault();
            toggleExpandAll();
            return;
        }

        let focusedPath: string | undefined;
        for (const [path, el] of rowRefs) {
            if (el === target) {
                focusedPath = path;
                break;
            }
        }
        if (focusedPath === undefined) return;

        const idx = visibleGroups.findIndex((g) => g.filePath === focusedPath);
        if (idx < 0) return;

        if (e.key === "ArrowDown" || e.key === "j") {
            e.preventDefault();
            const next = visibleGroups[Math.min(idx + 1, visibleGroups.length - 1)];
            if (next) focusRow(next.filePath);
        } else if (e.key === "ArrowUp" || e.key === "k") {
            e.preventDefault();
            const prev = visibleGroups[Math.max(idx - 1, 0)];
            if (prev) focusRow(prev.filePath);
        } else if (e.key === "Home") {
            e.preventDefault();
            const first = visibleGroups[0];
            if (first) focusRow(first.filePath);
        } else if (e.key === "End") {
            e.preventDefault();
            const last = visibleGroups[visibleGroups.length - 1];
            if (last) focusRow(last.filePath);
        }
    }
</script>

{#if threads.length > 0}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <section
        class="comments-panel"
        aria-label="Unresolved comments"
        role="group"
        onkeydown={onPanelKeydown}
    >
        <CommentSummaryBar
            {counts}
            {expandAll}
            {onlyWithReplies}
            onToggleExpandAll={toggleExpandAll}
            onToggleOnlyWithReplies={toggleOnlyWithReplies}
        />

        {#if visibleGroups.length === 0}
            <div class="empty-state">
                {#if onlyWithReplies}
                    no threads with replies
                {/if}
            </div>
        {:else}
            <ul class="comment-rows" role="list">
                {#each visibleGroups as group, idx (group.filePath)}
                    <CommentTestRow
                        filePath={group.filePath}
                        threads={group.threads}
                        {getThreadMessages}
                        open={isRowOpen(group.filePath)}
                        index={idx}
                        onToggleOpen={() => toggleRow(group.filePath)}
                        {onJump}
                        onTriggerRef={(el) => setRowRef(group.filePath, el)}
                    />
                {/each}
            </ul>
        {/if}
    </section>
{:else}
    <section class="comments-panel comments-panel--empty" aria-label="Unresolved comments">
        <div class="empty-state empty-state--quiet">no unresolved comment threads</div>
    </section>
{/if}

<style>
    .comments-panel {
        display: flex;
        flex-direction: column;
        background: var(--color-bg-secondary);
        border: 1px solid var(--color-border);
        border-radius: 10px;
        overflow: hidden;
        font-family: var(--font-mono);
        container-type: inline-size;
        container-name: comments;
    }

    .comments-panel--empty {
        padding: 10px 12px;
    }

    .comment-rows {
        list-style: none;
        padding: 0;
        margin: 0;
        display: flex;
        flex-direction: column;
    }

    .empty-state {
        padding: 14px 16px;
        font-family: var(--font-mono);
        font-size: 12px;
        color: var(--color-text-muted);
        font-style: italic;
    }

    .empty-state--quiet {
        padding: 10px 12px;
    }
</style>
