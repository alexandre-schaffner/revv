<script lang="ts">
import { isOpenLayer, loginsMatch, type PrStackDetail } from "@revv/shared";
import ArrowsClockwise from "phosphor-svelte/lib/ArrowsClockwise";
import type { Snippet } from "svelte";
import ConfirmDialog from "$lib/components/ui/confirm-dialog/ConfirmDialog.svelte";
import { viewerLoginOnPr } from "$lib/prs/viewer";
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

const viewer = $derived(viewerLoginOnPr(prId));
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
		title="Rebase stack #{stack.number}"
		confirmIcon={ArrowsClockwise}
		confirmLabel="Force-push {plural(pushed.length, 'branch', 'branches')}"
		onConfirm={() => {
			open = false;
			void rebaseStack(prId, stack);
		}}
		width={520}
	>
		{#snippet description()}
			Replay each open layer onto the one below it, starting from
			<code>{stack.baseRefName}</code>, then force-push {plural(pushed.length, 'branch', 'branches')}.
		{/snippet}
		{#snippet body()}
			<ul class="confirm-branches" aria-label="Branches to force-push">
				{#each pushed as layer (layer.number)}
					<li>
						<span class="pr-number">#{layer.number}</span>
						<div class="branch-info">
							<code class="branch">{layer.headRef}</code>
							{#if layer.authorLogin && !loginsMatch(layer.authorLogin, viewer)}
								<span class="owner">{layer.authorLogin}</span>
							{/if}
						</div>
					</li>
				{/each}
			</ul>

			<p class="confirm-note">Nothing is pushed if a layer conflicts or has changed.</p>

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
		flex-shrink: 0;
		max-height: 240px;
		margin: 4px 0;
		padding: 4px 0;
		overflow-y: auto;
		list-style: none;
		border-block: 1px solid var(--color-border-subtle);
	}

	.confirm-branches li {
		display: flex;
		align-items: baseline;
		gap: 16px;
		padding-block: 8px;
		font-size: 13px;
		line-height: 1.5;
	}

	.pr-number {
		flex-shrink: 0;
		font-variant-numeric: tabular-nums;
		color: var(--color-text-subtle);
	}

	.branch-info {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}

	.branch {
		font-family: var(--font-mono);
		font-size: inherit;
		overflow-wrap: anywhere;
	}

	.owner {
		color: var(--color-text-secondary);
	}
</style>
