<script lang="ts">
/*
 * An issue whose file an upper layer of the stack changes again: the card
 * stays put and its note hangs in the rail beside it (inline under it when
 * there's no rail). Without a note, just the card.
 */
import type { Snippet } from "svelte";
import ChangedAboveNote from "../margin/ChangedAboveNote.svelte";
import type { WalkthroughStack } from "./walkthrough-stack.svelte";

interface Props {
  stack: WalkthroughStack;
  issueId: string;
  children: Snippet;
}

let { stack, issueId, children }: Props = $props();

const note = $derived(stack.notes?.issues.get(issueId));
</script>

{#if note && stack.place}
	<div class="issue-noted">
		{@render children()}
		<div class="issue-rail-note" data-rail-note>
			<ChangedAboveNote {note} place={stack.place} forIssue />
		</div>
	</div>
{:else}
	{@render children()}
{/if}

<style>
	/* Across col 4's 40px gap, top-aligned with the card. Positioned so it
	   paints over the walkthrough that follows, which has a background of its
	   own. */
	.issue-noted {
		position: relative;
	}

	.issue-rail-note {
		position: absolute;
		top: 0;
		left: calc(100% + 40px);
		z-index: 2;
		width: 380px;
	}

	/* No rail: the note reads under its card. */
	@container (max-width: 1335px) {
		.issue-rail-note {
			position: static;
			width: auto;
			margin-top: 8px;
		}
	}
</style>
