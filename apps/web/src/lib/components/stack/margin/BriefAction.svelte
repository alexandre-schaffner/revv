<script lang="ts">
/*
 * The stack brief's one quiet affordance in the margin: write it when the
 * stack has none, refresh it when the stack moved past it. Never a button
 * that competes with the review; a line of muted text that does one thing.
 */
import ArrowsClockwise from "phosphor-svelte/lib/ArrowsClockwise";
import PencilSimpleLine from "phosphor-svelte/lib/PencilSimpleLine";
import { toast } from "svelte-sonner";
import { Shimmer } from "$lib/components/ai/shimmer";
import { requestStackBrief } from "$lib/stores/stacks.svelte";
import type { StackPlace } from "./stack-margin";

interface Props {
  place: StackPlace;
  /** One line, no lead-in: for the narrow layout's inline summary. */
  compact?: boolean;
}

let { place, compact = false }: Props = $props();

// Between the press and the stack read that shows the brief being written.
let askedFor = $state<string | null>(null);
const asking = $derived(askedFor === place.stack.brief?.id || askedFor === "none");

async function ask(): Promise<void> {
  askedFor = place.stack.brief?.id ?? "none";
  const id = await requestStackBrief(place.prId);
  if (id === null) {
    askedFor = null;
    toast.error("Couldn't start the stack brief.");
  }
}
</script>

{#if place.briefState === 'writing' || (asking && place.briefState !== 'current')}
	<span class="brief brief--writing"><Shimmer>Writing the stack brief…</Shimmer></span>
{:else if place.briefState === 'stale'}
	<span class="brief">
		{#if !compact}<span class="lead">Written for an earlier version of the stack.</span>{/if}
		<button type="button" class="act" onclick={ask}>
			<ArrowsClockwise size={12} weight="bold" aria-hidden="true" />Refresh
		</button>
	</span>
{:else if place.briefState === 'none'}
	<span class="brief">
		<button type="button" class="act" onclick={ask}>
			<PencilSimpleLine size={12} weight="bold" aria-hidden="true" />Write the stack brief
		</button>
	</span>
{/if}

<style>
	.brief {
		display: inline-flex;
		flex-wrap: wrap;
		align-items: baseline;
		column-gap: 6px;
		font-size: 12px;
		line-height: 1.5;
		color: var(--color-text-subtle);
	}

	.brief--writing {
		color: var(--color-text-muted);
	}

	.act {
		display: inline-flex;
		align-items: center;
		align-self: center;
		gap: 4px;
		margin: 0;
		padding: 0;
		border: 0;
		background: none;
		font: inherit;
		color: var(--color-text-muted);
		cursor: pointer;
	}

	.act:hover {
		color: var(--color-accent);
	}

	.act:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: 2px;
		border-radius: 3px;
	}
</style>
