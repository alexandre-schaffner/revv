<script lang="ts">
import { ArrowsClockwise, Spinner, Trash, Warning } from "phosphor-svelte";
import {
  discardProposedCommitAction,
  getWorktreeBlocked,
  isDiscardingCommit,
  isRebasingProposed,
  rebaseAllProposedAction,
} from "$lib/stores/chat.svelte";

interface Props {
  prId: string | undefined;
}

let { prId }: Props = $props();

const blocked = $derived(prId ? getWorktreeBlocked(prId) : null);
const isRebasing = $derived(prId ? isRebasingProposed(prId) : false);
</script>

{#if blocked}
  <div class="blocked-strip">
    <div class="blocked-header">
      <Warning size={12} class="blocked-icon" />
      <span class="blocked-title">
        PR head advanced — {blocked.commits.length} unpushed commit{blocked.commits.length === 1 ? '' : 's'}
      </span>
      <button
        class="blocked-rebase-btn"
        type="button"
        onclick={() => prId && rebaseAllProposedAction(prId)}
        disabled={isRebasing}
        title="Rebase all commits onto new PR head"
      >
        {#if isRebasing}
          <Spinner size={11} class="motion-essential-spin" />
          <span>Rebasing…</span>
        {:else}
          <ArrowsClockwise size={11} />
          <span>Rebase all</span>
        {/if}
      </button>
    </div>
    <ul class="blocked-list">
      {#each blocked.commits as commit (commit.sha)}
        <li class="blocked-item">
          <code class="blocked-sha">{commit.shortSha}</code>
          <span class="blocked-subject" title={commit.subject}>{commit.subject}</span>
          <button
            class="blocked-discard-btn"
            type="button"
            onclick={() => prId && discardProposedCommitAction(prId, commit.sha)}
            disabled={isDiscardingCommit(commit.sha) || isRebasing}
            title="Discard this commit"
            aria-label="Discard commit {commit.shortSha}"
          >
            {#if isDiscardingCommit(commit.sha)}
              <Spinner size={10} class="motion-essential-spin" />
            {:else}
              <Trash size={10} />
            {/if}
          </button>
        </li>
      {/each}
    </ul>
    <p class="blocked-hint">Rebase or discard all commits to continue chatting with the updated PR.</p>
  </div>
{/if}

<style>
  .blocked-strip {
    flex-shrink: 0;
    background: color-mix(in srgb, var(--color-warning) 8%, transparent);
    border-bottom: 1px solid color-mix(in srgb, var(--color-warning) 25%, transparent);
    padding: 8px 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .blocked-header {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  :global(.blocked-icon) {
    color: var(--color-warning);
    flex-shrink: 0;
  }

  .blocked-title {
    font-size: 12px;
    font-weight: 500;
    flex: 1;
    min-width: 0;
  }

  .blocked-rebase-btn {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    padding: 3px 8px;
    border-radius: 4px;
    border: 1px solid var(--color-border);
    background: var(--color-bg-secondary);
    cursor: pointer;
    color: var(--color-text-secondary);
    flex-shrink: 0;
    transition: background-color var(--duration-snap);
  }

  .blocked-rebase-btn:hover:not(:disabled) {
    background: var(--color-bg-tertiary);
    color: var(--color-text-primary);
  }

  .blocked-rebase-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .blocked-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .blocked-item {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
  }

  .blocked-sha {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--color-text-muted);
    flex-shrink: 0;
  }

  .blocked-subject {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .blocked-discard-btn {
    flex-shrink: 0;
    width: 20px;
    height: 20px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 3px;
    border: none;
    background: transparent;
    cursor: pointer;
    color: var(--color-text-muted);
    padding: 0;
    transition: background-color var(--duration-snap), color var(--duration-snap);
  }

  .blocked-discard-btn:hover:not(:disabled) {
    color: var(--color-danger);
    background: color-mix(in srgb, var(--color-danger) 10%, transparent);
  }

  .blocked-discard-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .blocked-hint {
    font-size: 11px;
    color: var(--color-text-muted);
    margin: 0;
  }
</style>
