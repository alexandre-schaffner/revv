<script lang="ts">
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
	.stack-overview-row {
		display: grid;
		grid-template-columns: var(--walkthrough-columns);
		row-gap: 12px;
		padding: 20px 0 8px;
	}

	.stack-overview-row > :global(*) {
		grid-column: 3;
	}

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

		.stack-overview-row > :global(* + *) {
			margin-top: 12px;
		}
	}
</style>
