<script lang="ts">
import type { Repository } from "@revv/shared";
import Trash from "phosphor-svelte/lib/Trash";
import ConfirmDialog from "$lib/components/ui/confirm-dialog/ConfirmDialog.svelte";

interface Props {
  repo: Repository | null;
  open?: boolean;
  onOpenChange: (open: boolean) => void;
  /** Starts the (optimistic) removal; the parent closes the dialog. */
  onConfirm: () => void;
}

let { repo, open = false, onOpenChange, onConfirm }: Props = $props();

// Parents clear `repo` as they close the dialog; keep the last one so the
// exit animation doesn't flash the "this repository" fallback copy.
let lastRepo: Repository | null = null;
const shownRepo = $derived.by(() => (lastRepo = repo ?? lastRepo));
let clonePath = $derived(shownRepo?.clonePath ?? "the local clone path");
let unmanaged = $derived(shownRepo?.managed === false);
</script>

<ConfirmDialog
	{open}
	{onOpenChange}
	tone="danger"
	icon={Trash}
	title="Remove {shownRepo?.fullName ?? 'this repository'}?"
	confirmIcon={Trash}
	confirmLabel="Remove"
	{onConfirm}
>
	{#snippet description()}
		{#if unmanaged}
			Revv stops tracking it and removes its worktrees. Your clone stays where it is:
		{:else}
			This permanently deletes Revv's cloned files. This can't be undone:
		{/if}
	{/snippet}
	{#snippet body()}
		<p class="confirm-path"><code>{clonePath}</code></p>
	{/snippet}
</ConfirmDialog>

<style>
	.confirm-path {
		margin: 0;
		border-radius: 7px;
		background: color-mix(in srgb, var(--color-text-primary) 5%, transparent);
		border: 1px solid var(--color-border-subtle);
		padding: 7px 10px;
		color: var(--color-text-primary);
		font-family: var(--font-mono);
		font-size: var(--text-ui);
		line-height: 1.45;
		overflow-wrap: anywhere;
	}

	.confirm-path code {
		color: inherit;
		font-family: inherit;
	}
</style>
