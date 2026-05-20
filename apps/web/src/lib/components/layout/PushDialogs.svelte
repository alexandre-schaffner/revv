<script lang="ts">
import { ArrowsClockwise, GitBranch, Spinner, Warning, X } from "phosphor-svelte";
import { tick } from "svelte";
import { Button } from "$lib/components/ui/button";
import * as Dialog from "$lib/components/ui/dialog";
import { Input } from "$lib/components/ui/input";
import {
  getProposedChanges,
  isPushingProposed,
} from "$lib/stores/chat.svelte";
import { getSelectedPr } from "$lib/stores/prs.svelte";
import { pushProposedChanges, type MergePushResult } from "$lib/api/chat";
import { toast } from "svelte-sonner";

interface Props {
  prId: string | undefined;
  conflictDialog: { files: string[]; branch: string } | null;
  onDismissConflict: () => void;
  onResolveAndPush: () => void;
  newBranchDialogOpen?: boolean;
  onNewBranchDialogClose: () => void;
  onPushSuccess: () => void;
}

let {
  prId,
  conflictDialog,
  onDismissConflict,
  onResolveAndPush,
  newBranchDialogOpen = $bindable(false),
  onNewBranchDialogClose,
  onPushSuccess,
}: Props = $props();

let newBranchDialogMode = $state<"input" | "confirm-overwrite">("input");
let newBranchValue = $state("");
let newBranchInputEl = $state<HTMLInputElement | null>(null);
let localPushing = $state(false);

const isPushing = $derived(prId ? isPushingProposed(prId) || localPushing : false);
const commitCount = $derived(
  prId ? (getProposedChanges(prId)?.commits.length ?? 0) : 0,
);

$effect(() => {
  if (newBranchDialogOpen) {
    newBranchDialogMode = "input";
    newBranchValue = suggestedNewBranchName();
    void tick().then(() => newBranchInputEl?.select());
  }
});

function suggestedNewBranchName(): string {
  const base = getSelectedPr()?.sourceBranch?.trim();
  return base && base.length > 0 ? `${base}-agent` : "agent-changes";
}

function isValidNewBranchName(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  if (/\s/.test(trimmed)) return false;
  if (trimmed.startsWith("-")) return false;
  if (trimmed.includes("..")) return false;
  return true;
}

async function handleNewBranchSubmit(): Promise<void> {
  if (!prId || newBranchDialogMode !== "input") return;
  const name = newBranchValue.trim();
  if (!isValidNewBranchName(name)) return;
  localPushing = true;
  try {
    const result = await pushProposedChanges(prId, { newBranchName: name });
    if (!result) {
      onNewBranchDialogClose();
      return;
    }
    if (result.status === "pushed") {
      onPushSuccess();
      onNewBranchDialogClose();
      return;
    }
    if (result.status === "ref-exists") {
      newBranchValue = name;
      newBranchDialogMode = "confirm-overwrite";
      return;
    }
    // 'conflict' / 'remote-changed' — close generically
    onNewBranchDialogClose();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : "Failed to push");
    onNewBranchDialogClose();
  } finally {
    localPushing = false;
  }
}

async function handleConfirmOverwrite(): Promise<void> {
  if (!prId || newBranchDialogMode !== "confirm-overwrite") return;
  localPushing = true;
  try {
    const result = await pushProposedChanges(prId, {
      newBranchName: newBranchValue,
      force: true,
    });
    if (result?.status === "pushed") {
      onPushSuccess();
    }
    onNewBranchDialogClose();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : "Failed to push");
    onNewBranchDialogClose();
  } finally {
    localPushing = false;
  }
}
</script>

<!-- Conflict dialog (shown after a push attempt finds conflicts) -->
{#if conflictDialog}
  <div
    class="diff-overlay"
    role="dialog"
    aria-modal="true"
    aria-label="Push conflicts"
  >
    <button
      type="button"
      class="diff-overlay-backdrop"
      aria-label="Close conflict dialog"
      onclick={onDismissConflict}
    ></button>
    <div class="conflict-card" role="document">
      <div class="conflict-card-header">
        <Warning size={14} class="conflict-card-icon" />
        <span class="conflict-card-title">Push conflicts</span>
        <button
          class="icon-btn"
          onclick={onDismissConflict}
          aria-label="Close conflict dialog"
        >
          <X size={14} />
        </button>
      </div>
      <div class="conflict-card-body">
        <p class="conflict-card-summary">
          The PR branch <code>{conflictDialog.branch}</code> has changed since the agent started, and merging the agent's commits would conflict in:
        </p>
        <ul class="conflict-file-list">
          {#each conflictDialog.files as file (file)}
            <li><code>{file}</code></li>
          {/each}
        </ul>
        <p class="conflict-card-hint">
          Want the agent to attempt resolving these conflicts? It will edit the affected files in the worktree, run <code>git merge --continue</code>, then push.
        </p>
      </div>
      <div class="conflict-card-footer">
        <button
          type="button"
          class="conflict-btn conflict-btn--secondary"
          onclick={onDismissConflict}
        >
          Cancel
        </button>
        <button
          type="button"
          class="conflict-btn conflict-btn--primary"
          onclick={onResolveAndPush}
        >
          Let agent resolve
        </button>
      </div>
    </div>
  </div>
{/if}

<!-- New-branch push dialog -->
<Dialog.Root bind:open={newBranchDialogOpen}>
  <Dialog.Portal>
    <Dialog.Overlay />
    <Dialog.Content class="new-branch-dialog-content">
      <Dialog.Header>
        <Dialog.Title>
          <span class="new-branch-title">
            {#if newBranchDialogMode === 'input'}
              <GitBranch size={16} />
              Push to a new branch
            {:else}
              <Warning size={16} class="new-branch-title-warn" />
              Branch already exists
            {/if}
          </span>
        </Dialog.Title>
        <Dialog.Description>
          {#if newBranchDialogMode === 'input'}
            Push the agent's commits to a brand-new branch on the remote. The
            current PR is not modified.
          {:else}
            <code>{newBranchValue}</code> already exists on the remote.
            Overwrite it with the agent's commits?
          {/if}
        </Dialog.Description>
      </Dialog.Header>

      {#if newBranchDialogMode === 'input'}
        <label class="new-branch-field">
          <span class="new-branch-label">Branch name</span>
          <Input
            bind:ref={newBranchInputEl}
            type="text"
            autocomplete="off"
            spellcheck={false}
            bind:value={newBranchValue}
            placeholder={suggestedNewBranchName()}
            disabled={isPushing}
            class="font-mono"
            onkeydown={(e: KeyboardEvent) => {
              if (e.key === 'Enter' && isValidNewBranchName(newBranchValue)) {
                e.preventDefault();
                void handleNewBranchSubmit();
              }
            }}
          />
        </label>
        {#if newBranchValue.length > 0 && !isValidNewBranchName(newBranchValue)}
          <p class="new-branch-hint new-branch-hint--error">
            Branch names can't be empty, contain spaces, start with
            <code>-</code>, or contain <code>..</code>.
          </p>
        {:else}
          <p class="new-branch-hint">
            The branch will start at the PR's head SHA plus the
            {commitCount} agent commit{commitCount === 1 ? '' : 's'}.
          </p>
        {/if}
      {:else}
        <p class="new-branch-hint">
          This force-pushes the new branch and will discard any commits on the
          existing remote ref.
        </p>
      {/if}

      <Dialog.Footer>
        <Button
          variant="outline"
          size="sm"
          onclick={() => onNewBranchDialogClose()}
          disabled={isPushing}
        >
          Cancel
        </Button>
        {#if newBranchDialogMode === 'input'}
          <Button
            variant="default"
            size="sm"
            onclick={handleNewBranchSubmit}
            disabled={isPushing || !isValidNewBranchName(newBranchValue)}
          >
            {#if isPushing}
              <Spinner size={12} class="motion-essential-spin" />
              Pushing…
            {:else}
              Push
            {/if}
          </Button>
        {:else}
          <Button
            variant="destructive"
            size="sm"
            onclick={handleConfirmOverwrite}
            disabled={isPushing}
          >
            {#if isPushing}
              <Spinner size={12} class="motion-essential-spin" />
              Overwriting…
            {:else}
              Overwrite
            {/if}
          </Button>
        {/if}
      </Dialog.Footer>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

<style>
  .diff-overlay {
    position: fixed;
    inset: 0;
    z-index: 1000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 32px;
  }

  .diff-overlay-backdrop {
    position: absolute;
    inset: 0;
    border: none;
    background: rgba(0, 0, 0, 0.5);
    cursor: default;
    padding: 0;
    margin: 0;
  }

  .conflict-card {
    position: relative;
    max-width: min(520px, 90vw);
    max-height: 80vh;
    background: var(--color-panel-bg);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .conflict-card-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--color-border-subtle);
    background: var(--color-bg-secondary);
  }

  :global(.conflict-card-icon) {
    color: var(--color-accent);
    flex-shrink: 0;
  }

  .conflict-card-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--color-text-primary);
    flex: 1;
    min-width: 0;
  }

  .conflict-card-body {
    padding: 14px 16px;
    font-size: 12px;
    line-height: 1.55;
    color: var(--color-text-secondary);
    overflow-y: auto;
  }

  .conflict-card-summary,
  .conflict-card-hint {
    margin: 0 0 10px;
  }

  .conflict-card-hint {
    margin: 12px 0 0;
    color: var(--color-text-muted);
  }

  .conflict-card-summary code,
  .conflict-card-hint code {
    font-family: var(--font-mono);
    font-size: 11px;
    background: var(--color-bg-tertiary);
    border-radius: 3px;
    padding: 1px 4px;
    color: var(--color-text-primary);
  }

  .conflict-file-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-height: 180px;
    overflow-y: auto;
  }

  .conflict-file-list li {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--color-text-primary);
    background: var(--color-bg-tertiary);
    border-radius: 3px;
    padding: 4px 6px;
  }

  .conflict-card-footer {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    padding: 10px 12px;
    border-top: 1px solid var(--color-border-subtle);
    background: var(--color-bg-secondary);
  }

  .conflict-btn {
    font-size: 12px;
    padding: 5px 12px;
    border-radius: 5px;
    border: 1px solid transparent;
    cursor: pointer;
    transition:
      background-color var(--duration-snap),
      border-color var(--duration-snap);
  }

  .conflict-btn--secondary {
    background: transparent;
    color: var(--color-text-secondary);
    border-color: var(--color-border-subtle);
  }

  .conflict-btn--secondary:hover {
    background: var(--color-bg-tertiary);
    color: var(--color-text-primary);
  }

  .conflict-btn--primary {
    background: var(--color-accent);
    color: var(--color-bg-primary);
    font-weight: 500;
  }

  .conflict-btn--primary:hover {
    opacity: 0.9;
  }

  .icon-btn {
    width: 24px;
    height: 24px;
    border-radius: 4px;
    border: none;
    background: transparent;
    color: var(--color-text-muted);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition:
      background-color var(--duration-snap),
      color var(--duration-snap);
  }

  .icon-btn:hover {
    background: var(--color-bg-tertiary);
    color: var(--color-text-secondary);
  }

  :global(.new-branch-dialog-content) {
    max-width: 440px !important;
    width: 100%;
  }

  .new-branch-title {
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }

  :global(.new-branch-title-warn) {
    color: var(--color-warning);
  }

  .new-branch-field {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 4px;
  }

  .new-branch-label {
    font-size: 11px;
    font-weight: 600;
    color: var(--color-text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .new-branch-hint {
    margin: 0;
    font-size: 11px;
    color: var(--color-text-muted);
    line-height: 1.4;
  }

  .new-branch-hint--error {
    color: var(--color-danger);
  }

  .new-branch-hint code {
    font-family: var(--font-mono);
    font-size: 10.5px;
    background: var(--color-bg-tertiary);
    border-radius: 3px;
    padding: 1px 4px;
  }
</style>
