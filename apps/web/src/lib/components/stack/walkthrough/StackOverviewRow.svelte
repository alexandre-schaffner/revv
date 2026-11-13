<script lang="ts">
import RestackBanner from "../RestackBanner.svelte";

interface Props {
  prId: string;
}

let { prId }: Props = $props();
</script>

<div class="stack-overview-row review-columns">
	<RestackBanner {prId} />
</div>

<style>
	.stack-overview-row {
		row-gap: 12px;
		padding: 20px 0 8px;
	}
</style>
