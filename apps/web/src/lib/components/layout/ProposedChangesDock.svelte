<script lang="ts">
import type { ChatTask } from "@revv/shared";
import {
  CheckCircle,
  Circle,
  Copy,
  GitCommit,
  GitMerge,
  PaperPlaneRight,
  Spinner,
  Trash,
  X,
} from "phosphor-svelte";
import { cubicIn, cubicOut } from "svelte/easing";
import { fly, slide } from "svelte/transition";
import { fetchProposedDiffFiles, type ProposedDiffFile } from "$lib/api/chat";
import {
  Queue,
  QueueItem,
  QueueItemAction,
  QueueItemActions,
  QueueItemContent,
  QueueItemIndicator,
  QueueList,
  QueueSection,
  QueueSectionContent,
  QueueSectionLabel,
  QueueSectionTrigger,
} from "$lib/components/ai/queue";
import ProposedDiffModal from "$lib/components/review/ProposedDiffModal.svelte";
import { Button } from "$lib/components/ui/button";
import { Checkbox } from "$lib/components/ui/checkbox";
import {
  batchCherryPickSelectedAction,
  batchDiscardSelectedAction,
  cherryPickProposedCommitAction,
  clearCommitSelection,
  discardProposedCommitAction,
  getProposedChanges,
  getQueuedMessages,
  getSelectedCommitCount,
  getSelectedCommitShas,
  isBatchOpInFlight,
  isCherryPickingCommit,
  isCommitSelected,
  isDiscardingCommit,
  isRebasingProposed,
  removeQueuedMessage,
  selectAllCommits,
  toggleCommitSelection,
} from "$lib/stores/chat.svelte";

interface Props {
  prId: string | undefined;
}

let { prId }: Props = $props();

const proposed = $derived(prId ? getProposedChanges(prId) : null);
const commitCount = $derived(proposed?.commits.length ?? 0);
const selectedShas = $derived(prId ? getSelectedCommitShas(prId) : new Set<string>());
const selectedCount = $derived(selectedShas.size);
const allSelected = $derived(commitCount > 0 && selectedCount === commitCount);
const batchInFlight = $derived(prId ? isBatchOpInFlight(prId) : false);
const isRebasing = $derived(prId ? isRebasingProposed(prId) : false);
const queuedMessages = $derived(prId ? getQueuedMessages(prId) : []);

/** Most recent task list from the agent — surfaces in the Queue dock. */
const activeTasks = $derived.by(() => {
  // Reconstruct from chat items; we need the parent to pass items, but
  // the task-list items are also stored in the chat history. For now we
  // read from the store directly to keep this component self-contained.
  // This is a slight coupling — the parent ChatTimeline knows items,
  // but the task-list kind is rendered exclusively here.
  return [] as ChatTask[];
});

// The activeTasks derivation above is a placeholder. In the original
// RightPanel, activeTasks was derived from `items` (chat items). Since
// ProposedChangesDock no longer has access to `items`, we need the
// parent to pass activeTasks as a prop. Let's add it.

let diffOpen = $state<{
  sha: string;
  subject: string;
  fileContents: ProposedDiffFile[] | null;
} | null>(null);

async function openDiff(commit: { sha: string; subject: string }): Promise<void> {
  if (!prId) return;
  diffOpen = { sha: commit.sha, subject: commit.subject, fileContents: null };
  try {
    const fileContents = await fetchProposedDiffFiles(prId, commit.sha);
    if (diffOpen) diffOpen = { sha: commit.sha, subject: commit.subject, fileContents };
  } catch (err) {
    diffOpen = null;
  }
}

function copyToClipboard(text: string): void {
  void navigator.clipboard?.writeText(text);
}

function filesSummary(files: string[]): string {
  const basenames = files.map((f) => f.split("/").pop() ?? f);
  if (basenames.length === 1) return basenames[0] ?? "";
  if (basenames.length === 2) return `${basenames[0]} · ${basenames[1]}`;
  return `${basenames[0]} · +${basenames.length - 1} more`;
}

// Reconstruct activeTasks from chat history items. We import getChatItems
// here so this component can remain self-contained.
import { getChatItems } from "$lib/stores/chat.svelte";

const items = $derived(prId ? getChatItems(prId) : []);
const activeTasksReal = $derived.by(() => {
  const taskList = items.findLast(
    (i): i is Extract<typeof i, { kind: "task-list" }> => i.kind === "task-list",
  );
  return taskList ? taskList.tasks : [];
});

const showQueueDock = $derived(
  queuedMessages.length > 0 || activeTasksReal.length > 0 || commitCount > 0,
);
</script>

{#if showQueueDock}
  <div class="queue-dock" transition:slide={{ duration: 220, easing: cubicOut }}>
    <Queue class="rounded-b-none border-b-0 shadow-none">
      <!-- Proposed commits from the agent -->
      {#if commitCount > 0 && proposed}
        <div transition:slide={{ duration: 220, easing: cubicOut }}>
          <QueueSection open={true}>
            <QueueSectionTrigger>
              <QueueSectionLabel
                label={commitCount === 1 ? 'proposed commit' : 'proposed commits'}
                count={commitCount}
              >
                {#snippet icon()}
                  <GitCommit class="size-3 text-accent" />
                {/snippet}
              </QueueSectionLabel>
              {#if proposed.branchName}
                <span class="ml-auto max-w-[140px] truncate font-mono text-xs text-muted-foreground">
                  {proposed.branchName}
                </span>
              {/if}
            </QueueSectionTrigger>
            <QueueSectionContent>
              <QueueList>
                {#each proposed.commits as commit, commitIdx (commit.sha)}
                  {@const checked = prId ? isCommitSelected(prId, commit.sha) : false}
                  <div
                    in:fly={{ y: 4, duration: 160, delay: Math.min(commitIdx, 8) * 25, easing: cubicOut }}
                    out:fly={{ y: -4, duration: 120, easing: cubicIn }}
                  >
                    <QueueItem class="items-start gap-2 py-1.5">
                      <Checkbox
                        class="mt-0.5"
                        {checked}
                        disabled={batchInFlight}
                        aria-label="Select commit {commit.shortSha} for batch action"
                        onclick={(e) => e.stopPropagation()}
                        onCheckedChange={() => {
                          if (prId) toggleCommitSelection(prId, commit.sha);
                        }}
                      />
                      <button
                        type="button"
                        class="flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5 border-0 bg-transparent p-0 text-left"
                        onclick={() => void openDiff(commit)}
                        title="View diff"
                      >
                        <span class="flex min-w-0 items-center gap-2">
                          <code class="shrink-0 font-mono text-[10px] text-accent">{commit.shortSha}</code>
                          <span class="truncate text-xs text-foreground">{commit.subject}</span>
                        </span>
                        {#if commit.files.length > 0}
                          <span class="truncate font-mono text-[10px] text-muted-foreground">
                            {filesSummary(commit.files)}
                          </span>
                        {/if}
                      </button>
                      {#if selectedCount === 0}
                        <QueueItemActions>
                          <QueueItemAction
                            class="opacity-100"
                            onclick={() => copyToClipboard(commit.sha)}
                            aria-label="Copy SHA"
                            title="Copy SHA"
                          >
                            <Copy class="size-3" />
                          </QueueItemAction>
                          <QueueItemAction
                            class="opacity-100 hover:text-destructive"
                            disabled={isDiscardingCommit(commit.sha)}
                            onclick={() => {
                              if (prId) void discardProposedCommitAction(prId, commit.sha);
                            }}
                            aria-label="Discard commit"
                            title="Discard commit"
                          >
                            {#if isDiscardingCommit(commit.sha)}
                              <Spinner class="size-3 motion-essential-spin" />
                            {:else}
                              <Trash class="size-3" />
                            {/if}
                          </QueueItemAction>
                          <QueueItemAction
                            class="opacity-100 hover:text-primary"
                            disabled={isCherryPickingCommit(commit.sha)}
                            onclick={() => {
                              if (prId) void cherryPickProposedCommitAction(prId, commit.sha);
                            }}
                            aria-label="Push this commit to PR branch"
                            title="Push this commit to PR branch"
                          >
                            {#if isCherryPickingCommit(commit.sha)}
                              <Spinner class="size-3 motion-essential-spin" />
                            {:else}
                              <GitMerge class="size-3" />
                            {/if}
                          </QueueItemAction>
                        </QueueItemActions>
                      {/if}
                    </QueueItem>
                  </div>
                {/each}
              </QueueList>
              {#if selectedCount > 0}
                <div
                  class="proposed-batch-footer"
                  transition:slide={{ duration: 160, easing: cubicOut }}
                >
                  <div class="proposed-batch-footer__info">
                    <span class="text-xs text-muted-foreground tabular-nums">
                      {selectedCount} of {commitCount} selected
                    </span>
                    {#if !allSelected}
                      <button
                        type="button"
                        class="proposed-batch-footer__link"
                        disabled={batchInFlight}
                        onclick={() => {
                          if (prId)
                            selectAllCommits(prId, proposed.commits.map((c) => c.sha));
                        }}
                      >
                        Select all
                      </button>
                    {/if}
                    <button
                      type="button"
                      class="proposed-batch-footer__link"
                      disabled={batchInFlight}
                      onclick={() => {
                        if (prId) clearCommitSelection(prId);
                      }}
                    >
                      Clear
                    </button>
                  </div>
                  <div class="proposed-batch-footer__actions">
                    <Button
                      variant="ghost"
                      size="sm"
                      class="h-7 gap-1.5 px-2 text-xs hover:text-destructive"
                      disabled={batchInFlight}
                      onclick={() => {
                        if (prId) void batchDiscardSelectedAction(prId);
                      }}
                    >
                      {#if batchInFlight}
                        <Spinner class="size-3 motion-essential-spin" />
                      {:else}
                        <Trash class="size-3" />
                      {/if}
                      Discard {selectedCount}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      class="h-7 gap-1.5 px-2 text-xs hover:text-primary"
                      disabled={batchInFlight}
                      onclick={() => {
                        if (prId) void batchCherryPickSelectedAction(prId);
                      }}
                    >
                      {#if batchInFlight}
                        <Spinner class="size-3 motion-essential-spin" />
                      {:else}
                        <GitMerge class="size-3" />
                      {/if}
                      Push {selectedCount} to PR branch
                    </Button>
                  </div>
                </div>
              {/if}
            </QueueSectionContent>
          </QueueSection>
        </div>
      {/if}

      <!-- Active todo list from the agent -->
      {#if activeTasksReal.length > 0}
        {@const completed = activeTasksReal.filter((t) => t.status === 'completed').length}
        {@const allDone = completed === activeTasksReal.length}
        <div transition:slide={{ duration: 220, easing: cubicOut }}>
          <QueueSection open={!allDone}>
            <QueueSectionTrigger>
              <QueueSectionLabel
                label={activeTasksReal.length === 1 ? 'todo' : 'todos'}
                count={activeTasksReal.length}
              >
                {#snippet icon()}
                  {#if activeTasksReal.some((t) => t.status === 'in_progress')}
                    <Spinner class="size-3 text-primary motion-essential-spin animate-spin" />
                  {:else if allDone}
                    <CheckCircle class="size-3 text-success" />
                  {:else}
                    <Circle class="size-3 text-muted-foreground" />
                  {/if}
                {/snippet}
              </QueueSectionLabel>
              <span class="ml-auto text-xs tabular-nums text-muted-foreground">
                {completed}/{activeTasksReal.length}
              </span>
            </QueueSectionTrigger>
            <QueueSectionContent>
              <QueueList>
                {#each activeTasksReal as task, taskIdx (task.id)}
                  <div
                    in:fly={{ y: 4, duration: 160, delay: Math.min(taskIdx, 8) * 25, easing: cubicOut }}
                    out:fly={{ y: -4, duration: 120, easing: cubicIn }}
                  >
                    <QueueItem>
                      <QueueItemIndicator completed={task.status === 'completed'} />
                      <QueueItemContent completed={task.status === 'completed'}>
                        {#if task.status === 'in_progress' && task.activeForm}
                          {task.activeForm}
                        {:else}
                          {task.content}
                        {/if}
                      </QueueItemContent>
                    </QueueItem>
                  </div>
                {/each}
              </QueueList>
            </QueueSectionContent>
          </QueueSection>
        </div>
      {/if}

      <!-- Queued messages (submitted while agent is busy) -->
      {#if queuedMessages.length > 0}
        <div transition:slide={{ duration: 220, easing: cubicOut }}>
          <QueueSection>
            <QueueSectionTrigger>
              <QueueSectionLabel
                label={queuedMessages.length === 1 ? 'queued message' : 'queued messages'}
                count={queuedMessages.length}
              >
                {#snippet icon()}
                  <PaperPlaneRight class="size-3 text-muted-foreground" />
                {/snippet}
              </QueueSectionLabel>
            </QueueSectionTrigger>
            <QueueSectionContent>
              <QueueList>
                {#each queuedMessages as msg, msgIdx (msg.id)}
                  <div
                    in:fly={{ y: 4, duration: 160, delay: Math.min(msgIdx, 8) * 25, easing: cubicOut }}
                    out:fly={{ y: -4, duration: 120, easing: cubicIn }}
                  >
                    <QueueItem>
                      <QueueItemContent>{msg.text}</QueueItemContent>
                      <QueueItemActions>
                        <QueueItemAction
                          onclick={() => prId && removeQueuedMessage(prId, msg.id)}
                          aria-label="Remove queued message"
                        >
                          <X class="size-3" />
                        </QueueItemAction>
                      </QueueItemActions>
                    </QueueItem>
                  </div>
                {/each}
              </QueueList>
            </QueueSectionContent>
          </QueueSection>
        </div>
      {/if}
    </Queue>
  </div>
{/if}

{#if diffOpen && prId}
  <ProposedDiffModal
    {prId}
    sha={diffOpen.sha}
    subject={diffOpen.subject}
    fileContents={diffOpen.fileContents}
    onClose={() => (diffOpen = null)}
  />
{/if}

<style>
  .queue-dock {
    padding: 8px 10px 0;
    background: var(--color-panel-bg);
    flex-shrink: 0;
  }

  .proposed-batch-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 6px 12px 8px;
    border-top: 1px solid var(--color-border-subtle);
  }

  .proposed-batch-footer__info {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }

  .proposed-batch-footer__actions {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .proposed-batch-footer__link {
    background: transparent;
    border: none;
    padding: 0;
    font-size: 11px;
    color: var(--color-text-muted);
    cursor: pointer;
    text-decoration: underline;
    text-decoration-color: color-mix(in srgb, var(--color-text-muted) 40%, transparent);
    text-underline-offset: 2px;
  }

  .proposed-batch-footer__link:hover:not(:disabled) {
    color: var(--color-text-secondary);
    text-decoration-color: currentColor;
  }

  .proposed-batch-footer__link:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
