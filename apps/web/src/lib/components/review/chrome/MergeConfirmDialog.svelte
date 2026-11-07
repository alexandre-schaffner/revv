<script lang="ts">
import GitMerge from "phosphor-svelte/lib/GitMerge";
import ShieldWarning from "phosphor-svelte/lib/ShieldWarning";
import ConfirmDialog from "$lib/components/ui/confirm-dialog/ConfirmDialog.svelte";

interface Props {
  open: boolean;
  prNumber: number;
  /** Null when the viewer is merging their own pull request. */
  authorLogin: string | null;
  targetBranch: string;
  methodLabel: string;
  /** The branch-protection rule this merge bypasses, or null for a plain merge. */
  bypassRule: string | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

let {
  open,
  prNumber,
  authorLogin,
  targetBranch,
  methodLabel,
  bypassRule,
  onOpenChange,
  onConfirm,
}: Props = $props();

const whose = $derived(authorLogin === null ? "your" : `${authorLogin}'s`);
const bypass = $derived(bypassRule !== null);
</script>

<ConfirmDialog
	{open}
	{onOpenChange}
	tone={bypass ? 'warning' : 'success'}
	icon={bypass ? ShieldWarning : GitMerge}
	title={bypass ? `Bypass rules and merge #${prNumber}?` : `Merge #${prNumber}?`}
	confirmIcon={bypass ? ShieldWarning : GitMerge}
	confirmLabel={bypass ? 'Bypass rules and merge' : methodLabel}
	{onConfirm}
>
	{#snippet description()}
		{#if bypassRule !== null}
			{bypassRule}. This bypasses branch protections and merges {whose} pull request into
			<code>{targetBranch}</code> anyway ({methodLabel.toLowerCase()}). It can't be
			undone from Revv.
		{:else}
			This merges {whose} pull request into <code>{targetBranch}</code>
			({methodLabel.toLowerCase()}). It can't be undone from Revv.
		{/if}
	{/snippet}
</ConfirmDialog>
