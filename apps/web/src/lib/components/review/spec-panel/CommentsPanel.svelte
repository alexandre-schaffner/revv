<script lang="ts">
/*
 * Unresolved comment threads, one row per file; the open row lists every
 * thread on that file. Rows start expanded.
 */
import type { CommentThread, ThreadMessage } from "@revv/shared";
import Chat from "phosphor-svelte/lib/Chat";
import Circle from "phosphor-svelte/lib/Circle";
import { groupThreadsByFile } from "$lib/utils/group-threads";
import CommentRow from "./CommentRow.svelte";
import { createExpandState } from "./expand-state.svelte";
import { createRowKeys } from "./row-keys";
import SpecCount from "./SpecCount.svelte";
import SpecEmpty from "./SpecEmpty.svelte";
import SpecPanel from "./SpecPanel.svelte";
import SpecSummaryBar from "./SpecSummaryBar.svelte";

interface Props {
  threads: readonly CommentThread[];
  getThreadMessages: (threadId: string) => ThreadMessage[];
  onJump: (filePath: string, line: number) => void;
  onDiscard?: ((threadId: string) => void) | undefined;
}

let { threads, getThreadMessages, onJump, onDiscard }: Props = $props();

let onlyWithReplies = $state(false);

function hasReplies(thread: CommentThread): boolean {
  return (getThreadMessages(thread.id)?.length ?? 0) > 1;
}

const withRepliesCount = $derived(threads.filter(hasReplies).length);

const visibleGroups = $derived(
  groupThreadsByFile(onlyWithReplies ? threads.filter(hasReplies) : threads),
);

const groupPaths = $derived(visibleGroups.map((g) => g.filePath));

const expand = createExpandState(() => groupPaths, true);

const keys = createRowKeys({ order: () => groupPaths, toggleAll: () => expand.toggleAll() });
</script>

{#if threads.length > 0}
    <SpecPanel label="Unresolved comments" onkeydown={keys.onkeydown}>
        <SpecSummaryBar
            title="Comments"
            expand={{ all: expand.all, onToggle: () => expand.toggleAll() }}
            filters={[
                {
                    label: "Only with replies",
                    active: onlyWithReplies,
                    onToggle: () => (onlyWithReplies = !onlyWithReplies),
                },
            ]}
        >
            {#snippet icon()}<Chat size={14} />{/snippet}
            {#snippet counts()}
                <SpecCount tone="accent" count={threads.length} label="unresolved">
                    <Circle size={11} weight="fill" />
                </SpecCount>
                <SpecCount tone="muted" count={withRepliesCount} label="with replies">
                    <Circle size={11} weight="fill" />
                </SpecCount>
            {/snippet}
        </SpecSummaryBar>

        {#if visibleGroups.length === 0}
            <SpecEmpty>
                {#if onlyWithReplies}
                    no threads with replies
                {/if}
            </SpecEmpty>
        {:else}
            <ul class="comment-rows" role="list">
                {#each visibleGroups as group (group.filePath)}
                    <CommentRow
                        filePath={group.filePath}
                        threads={group.threads}
                        {getThreadMessages}
                        open={expand.isOpen(group.filePath)}
                        onToggleOpen={() => expand.toggle(group.filePath)}
                        {onJump}
                        {onDiscard}
                        onTriggerRef={keys.trigger(group.filePath)}
                    />
                {/each}
            </ul>
        {/if}
    </SpecPanel>
{:else}
    <SpecPanel label="Unresolved comments" empty="no unresolved comment threads" />
{/if}

<style>
    .comment-rows {
        list-style: none;
        padding: 0;
        margin: 0;
        display: flex;
        flex-direction: column;
    }
</style>
