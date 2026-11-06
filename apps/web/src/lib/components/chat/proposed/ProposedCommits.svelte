<script lang="ts">
// The agent's unpushed commits in the queue dock: open one's diff, act on one,
// or select several for one push or discard.
import Copy from "phosphor-svelte/lib/Copy";
import GitCommit from "phosphor-svelte/lib/GitCommit";
import GitMerge from "phosphor-svelte/lib/GitMerge";
import Spinner from "phosphor-svelte/lib/Spinner";
import Trash from "phosphor-svelte/lib/Trash";
import { toast } from "svelte-sonner";
import { fetchProposedDiffFiles, type ProposedChanges, type ProposedDiffFile } from "$lib/api/chat";
import {
  batchCherryPickSelectedAction,
  batchDiscardSelectedAction,
  cherryPickProposedCommitAction,
  clearCommitSelection,
  discardProposedCommitAction,
  getSelectedCommitShas,
  isBatchOpInFlight,
  isCherryPickingCommit,
  isDiscardingCommit,
  selectAllCommits,
  toggleCommitSelection,
} from "$lib/chat/proposed.svelte";
import { Button } from "$lib/components/ui/button";
import { Checkbox } from "$lib/components/ui/checkbox";
import { gsapFadeY, gsapSlide, tokens } from "$lib/motion";
import QueueItem from "../queue/QueueItem.svelte";
import QueueItemAction from "../queue/QueueItemAction.svelte";
import QueueSection from "../queue/QueueSection.svelte";
import ProposedDiffModal from "./ProposedDiffModal.svelte";

interface Props {
  prId: string;
  proposed: ProposedChanges;
}

let { prId, proposed }: Props = $props();

const commitCount = $derived(proposed.commits.length);
const selected = $derived(getSelectedCommitShas(prId));
const selectedCount = $derived(selected.size);
const batchInFlight = $derived(isBatchOpInFlight(prId));

let diffOpen = $state<{
  sha: string;
  subject: string;
  fileContents: ProposedDiffFile[] | null;
} | null>(null);

async function openDiff(commit: { sha: string; subject: string }): Promise<void> {
  // The modal shows a skeleton until the contents land.
  diffOpen = { sha: commit.sha, subject: commit.subject, fileContents: null };
  try {
    const fileContents = await fetchProposedDiffFiles(prId, commit.sha);
    if (diffOpen) diffOpen = { sha: commit.sha, subject: commit.subject, fileContents };
  } catch (err) {
    diffOpen = null;
    toast.error(err instanceof Error ? err.message : "Failed to load diff");
  }
}

function filesSummary(files: readonly string[]): string {
  const basenames = files.map((f) => f.split("/").pop() ?? f);
  if (basenames.length === 1) return basenames[0] ?? "";
  if (basenames.length === 2) return `${basenames[0]} · ${basenames[1]}`;
  return `${basenames[0]} · +${basenames.length - 1} more`;
}
</script>

<QueueSection label={commitCount === 1 ? "proposed commit" : "proposed commits"} count={commitCount}>
	{#snippet icon()}
		<GitCommit class="size-3 text-accent" />
	{/snippet}
	{#snippet trailing()}
		{#if proposed.branchName}
			<span class="ml-auto max-w-[140px] truncate font-mono text-xs text-muted-foreground">
				{proposed.branchName}
			</span>
		{/if}
	{/snippet}
	{#each proposed.commits as commit, commitIdx (commit.sha)}
		<div
			in:gsapFadeY={{ y: 4, duration: tokens.quick, delay: Math.min(commitIdx, 8) * tokens.stagger.tight }}
			out:gsapFadeY={{ y: -4, duration: tokens.snap }}
		>
			<QueueItem class="items-start gap-2 py-1.5">
				<Checkbox
					class="mt-0.5"
					checked={selected.has(commit.sha)}
					disabled={batchInFlight}
					aria-label="Select commit {commit.shortSha} for batch action"
					onclick={(e) => e.stopPropagation()}
					onCheckedChange={() => toggleCommitSelection(prId, commit.sha)}
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
					<div data-slot="queue-item-actions" class="flex gap-1">
						<QueueItemAction
							class="opacity-100"
							onclick={() => void navigator.clipboard?.writeText(commit.sha)}
							aria-label="Copy SHA"
							title="Copy SHA"
						>
							<Copy class="size-3" />
						</QueueItemAction>
						<QueueItemAction
							class="opacity-100 hover:text-destructive"
							disabled={isDiscardingCommit(prId, commit.sha)}
							onclick={() => void discardProposedCommitAction(prId, commit.sha)}
							aria-label="Discard commit"
							title="Discard commit"
						>
							{#if isDiscardingCommit(prId, commit.sha)}
								<Spinner class="size-3 motion-essential-spin" />
							{:else}
								<Trash class="size-3" />
							{/if}
						</QueueItemAction>
						<QueueItemAction
							class="opacity-100 hover:text-primary"
							disabled={isCherryPickingCommit(prId, commit.sha)}
							onclick={() => void cherryPickProposedCommitAction(prId, commit.sha)}
							aria-label="Push this commit to PR branch"
							title="Push this commit to PR branch"
						>
							{#if isCherryPickingCommit(prId, commit.sha)}
								<Spinner class="size-3 motion-essential-spin" />
							{:else}
								<GitMerge class="size-3" />
							{/if}
						</QueueItemAction>
					</div>
				{/if}
			</QueueItem>
		</div>
	{/each}
	{#snippet footer()}
		{#if selectedCount > 0}
			<div class="batch-footer" transition:gsapSlide={{ duration: tokens.quick }}>
				<div class="batch-footer__info">
					<span class="text-xs text-muted-foreground tabular-nums">
						{selectedCount} of {commitCount} selected
					</span>
					{#if selectedCount < commitCount}
						<button
							type="button"
							class="batch-footer__link"
							disabled={batchInFlight}
							onclick={() => selectAllCommits(prId, proposed.commits.map((c) => c.sha))}
						>
							Select all
						</button>
					{/if}
					<button
						type="button"
						class="batch-footer__link"
						disabled={batchInFlight}
						onclick={() => clearCommitSelection(prId)}
					>
						Clear
					</button>
				</div>
				<div class="batch-footer__actions">
					<Button
						variant="ghost"
						size="sm"
						class="h-7 gap-1.5 px-2 text-xs hover:text-destructive"
						disabled={batchInFlight}
						onclick={() => void batchDiscardSelectedAction(prId)}
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
						onclick={() => void batchCherryPickSelectedAction(prId)}
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
	{/snippet}
</QueueSection>

{#if diffOpen}
	<ProposedDiffModal
		{prId}
		sha={diffOpen.sha}
		subject={diffOpen.subject}
		fileContents={diffOpen.fileContents}
		open={true}
		onOpenChange={(v) => {
			if (!v) diffOpen = null;
		}}
	/>
{/if}

<style>
	.batch-footer {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 6px 12px 8px;
		border-top: 1px solid var(--color-border-subtle);
	}

	.batch-footer__info {
		display: flex;
		align-items: center;
		gap: 10px;
		min-width: 0;
	}

	.batch-footer__actions {
		display: flex;
		align-items: center;
		gap: 4px;
	}

	.batch-footer__link {
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

	.batch-footer__link:hover:not(:disabled) {
		color: var(--color-text-secondary);
		text-decoration-color: currentColor;
	}

	.batch-footer__link:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>
