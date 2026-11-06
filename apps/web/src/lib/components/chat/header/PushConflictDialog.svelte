<script lang="ts">
// A push found the PR branch moved and the agent's commits conflict with it:
// offer to let the agent resolve the conflicts and push.
import GitMerge from "phosphor-svelte/lib/GitMerge";
import Warning from "phosphor-svelte/lib/Warning";
import ConfirmDialog from "$lib/components/ui/confirm-dialog/ConfirmDialog.svelte";

interface Props {
  conflict: { files: readonly string[]; branch: string } | null;
  onClose: () => void;
  onResolve: () => void;
}

let { conflict, onClose, onResolve }: Props = $props();

// Kept while the dialog animates out after `conflict` clears.
let shown = $state<{ files: readonly string[]; branch: string }>({ files: [], branch: "" });
$effect(() => {
  if (conflict) shown = conflict;
});
</script>

<ConfirmDialog
	open={conflict !== null}
	onOpenChange={(open) => {
		if (!open) onClose();
	}}
	tone="warning"
	icon={Warning}
	title="Push conflicts"
	confirmIcon={GitMerge}
	confirmLabel="Let agent resolve"
	onConfirm={onResolve}
	width={520}
>
	{#snippet description()}
		The PR branch <code>{shown.branch}</code> has changed since the agent started, and merging the
		agent's commits would conflict in:
	{/snippet}
	{#snippet body()}
		<ul class="conflict-files">
			{#each shown.files as file (file)}
				<li><code>{file}</code></li>
			{/each}
		</ul>
		<p class="conflict-hint">
			Want the agent to attempt resolving these conflicts? It will edit the affected files in the
			worktree, run <code>git merge --continue</code>, then push.
		</p>
	{/snippet}
</ConfirmDialog>

<style>
	.conflict-files {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 4px;
		max-height: 180px;
		overflow-y: auto;
	}

	.conflict-files li {
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--color-text-primary);
		background: var(--color-bg-tertiary);
		border-radius: 3px;
		padding: 4px 6px;
	}

	.conflict-hint {
		margin: 0;
		font-size: 12px;
		line-height: 1.55;
		color: var(--color-text-muted);
	}

	.conflict-hint code {
		font-family: var(--font-mono);
		font-size: 11px;
		background: var(--color-bg-tertiary);
		border-radius: 3px;
		padding: 1px 4px;
		color: var(--color-text-primary);
	}
</style>
