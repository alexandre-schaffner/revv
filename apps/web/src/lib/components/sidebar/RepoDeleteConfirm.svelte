<script lang="ts">
import type { Repository } from "@revv/shared";
import Trash from "phosphor-svelte/lib/Trash";
import ConfirmDialog from "$lib/components/ui/confirm-dialog/ConfirmDialog.svelte";

interface Props {
  repo: Repository | null;
  open?: boolean;
  deleting?: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

let { repo, open = false, deleting = false, onOpenChange, onConfirm }: Props = $props();

let clonePath = $derived(repo?.clonePath ?? "the local clone path");
let unmanaged = $derived(repo?.managed === false);
</script>

<ConfirmDialog
	{open}
	{onOpenChange}
	tone="danger"
	icon={Trash}
	title="Remove {repo?.fullName ?? 'this repository'}?"
	confirmIcon={Trash}
	confirmLabel="Remove"
	pending={deleting}
	pendingLabel="Removing…"
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
		font-family: var(--font-mono, ui-monospace, SFMono-Regular, monospace);
		font-size: 11.5px;
		line-height: 1.45;
		overflow-wrap: anywhere;
	}

	.confirm-path code {
		color: inherit;
		font-family: inherit;
	}
</style>
