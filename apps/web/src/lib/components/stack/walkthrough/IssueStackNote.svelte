<script lang="ts">
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

	@container (max-width: 1335px) {
		.issue-rail-note {
			position: static;
			width: auto;
			margin-top: 8px;
		}
	}
</style>
