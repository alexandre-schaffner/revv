<script lang="ts">
import { isOpenLayer, loginsMatch, type PrStackDetail } from "@revv/shared";
import ArrowsClockwise from "phosphor-svelte/lib/ArrowsClockwise";
import type { Snippet } from "svelte";
import ConfirmDialog from "$lib/components/ui/confirm-dialog/ConfirmDialog.svelte";
import { getCurrentUserLogin } from "$lib/stores/auth.svelte";
import { getStackRebase, rebaseStack } from "$lib/stores/stack-rebase.svelte";
import { plural } from "$lib/utils/plural";

// "Rebase stack": the caller draws the trigger; this owns the confirm and
// the rebase. Nothing renders for a viewer who can't push the stack.

interface TriggerProps {
  readonly rebasing: boolean;
  readonly title: string;
  readonly onclick: () => void;
}

interface Props {
  prId: string;
  stack: PrStackDetail;
  trigger: Snippet<[TriggerProps]>;
}

let { prId, stack, trigger }: Props = $props();

let open = $state(false);
const rebasing = $derived(getStackRebase(stack).status === "loading");
const title = $derived(
  `Replay every open layer onto the one below it, the bottom onto ${stack.baseRefName}, and force-push them together. Nothing is pushed if any layer conflicts or moved meanwhile.`,
);

const viewer = $derived(getCurrentUserLogin());
const pushed = $derived(stack.layers.filter(isOpenLayer).reverse());
const othersOwn = $derived(
  pushed.some((l) => l.authorLogin !== null && !loginsMatch(l.authorLogin, viewer)),
);
</script>

{#if stack.viewerCanPush}
	{@render trigger({
		rebasing,
		title,
		onclick: () => (open = true),
	})}
	<ConfirmDialog
		{open}
		onOpenChange={(next) => (open = next)}
		tone="warning"
		icon={ArrowsClockwise}
		title="Rebase stack #{stack.number}?"
		confirmIcon={ArrowsClockwise}
		confirmLabel="Force-push {plural(pushed.length, 'branch', 'branches')}"
		onConfirm={() => {
			open = false;
			void rebaseStack(prId, stack);
		}}
		width={440}
	>
		{#snippet description()}
			Revv replays each open layer onto the one below it, the bottom onto
			<code>{stack.baseRefName}</code>, and force-pushes {pushed.length === 1
				? 'its branch'
				: `these ${pushed.length} branches`} together. Nothing is pushed if a layer
			conflicts or moved meanwhile.
		{/snippet}
		{#snippet body()}
			<ul class="confirm-branches">
				{#each pushed as layer (layer.number)}
					<li>
						<code class="branch">{layer.headRef}</code>
						<span class="owner">
							#{layer.number}{#if layer.authorLogin && !loginsMatch(layer.authorLogin, viewer)}
								· {layer.authorLogin}'s{/if}
						</span>
					</li>
				{/each}
			</ul>

			{#if othersOwn}
				<p class="confirm-note">
					Anyone with these branches checked out will need to reset onto the new heads.
				</p>
			{/if}
		{/snippet}
	</ConfirmDialog>
{/if}

<style>
	.confirm-note {
		margin: 0;
		font-size: 12px;
		line-height: 1.55;
		overflow-wrap: anywhere;
		color: var(--color-text-muted);
	}

	.confirm-branches {
		display: flex;
		flex-direction: column;
		gap: 2px;
		max-height: 180px;
		margin: 0;
		padding: 7px 10px;
		overflow-y: auto;
		list-style: none;
		border: 1px solid var(--color-border-subtle);
		border-radius: 7px;
		background: color-mix(in srgb, var(--color-text-primary) 5%, transparent);
	}

	.confirm-branches li {
		display: flex;
		align-items: baseline;
		gap: 8px;
		min-width: 0;
		font-size: 12px;
		line-height: 1.5;
	}

	.branch {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--font-mono);
		font-size: 11.5px;
		color: var(--color-text-primary);
	}

	.owner {
		flex-shrink: 0;
		color: var(--color-text-muted);
	}
</style>
