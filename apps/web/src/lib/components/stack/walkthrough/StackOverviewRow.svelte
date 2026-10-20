<script lang="ts">
/*
 * How the stack moved under this review, at the top of a stacked PR's
 * walkthrough. Above the chapters and outside them, so the chapter numbering
 * the chat refers to stays put.
 */
import RestackBanner from "../RestackBanner.svelte";

interface Props {
  prId: string;
}

let { prId }: Props = $props();
</script>

<div class="stack-overview-row">
	<RestackBanner {prId} />
</div>

<style>
	/* The walkthrough's 6-col grid (`--walkthrough-columns`, set by
	   GuidedWalkthrough), so the banner lands on col 3 like the stepper
	   header. */
	.stack-overview-row {
		display: grid;
		grid-template-columns: var(--walkthrough-columns);
		row-gap: 12px;
		padding: 20px 0 8px;
	}

	.stack-overview-row > :global(*) {
		grid-column: 3;
	}

	/* No rail: the same stacked layout as the walkthrough's other
	   single-column rows. */
	@container (max-width: 1335px) {
		.stack-overview-row {
			display: block;
			width: 100%;
			max-width: calc(72px + 820px + 32px);
			padding-left: 72px;
			padding-right: 32px;
			margin-inline: 0;
			box-sizing: border-box;
		}

		.stack-overview-row > :global(*) {
			grid-column: auto;
		}

		/* Block layout has no row gap; the banner keeps its distance. */
		.stack-overview-row > :global(* + *) {
			margin-top: 12px;
		}
	}
</style>
