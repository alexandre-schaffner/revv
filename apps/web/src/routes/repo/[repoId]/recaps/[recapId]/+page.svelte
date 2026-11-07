<script lang="ts">
import { goto } from "$app/navigation";
import { page } from "$app/state";
import RecapActions from "$lib/components/recaps/RecapActions.svelte";
import RecapArchivePopover from "$lib/components/recaps/RecapArchivePopover.svelte";
import RecapDetail from "$lib/components/recaps/RecapDetail.svelte";
import { RecapController } from "$lib/components/recaps/recap-controller.svelte";
import { utcDayKey } from "$lib/recaps/period-window";
import { useRecapsForRepo } from "$lib/recaps/store.svelte";

const repoId = $derived(page.params.repoId ?? "");
const recapId = $derived(page.params.recapId ?? "");

const controller = new RecapController(
  () => repoId,
  () => recapId || null,
);
const recap = $derived(controller.recap);

// For the archive popover.
const repoRecaps = useRecapsForRepo(() => repoId);

function onBack(): void {
  void goto(`/repo/${repoId}/recaps`);
}
</script>

{#if recap}
	<RecapActions
		{controller}
		period={recap.period}
		ongenerated={(id) => void goto(`/repo/${repoId}/recaps/${id}`)}
	/>
{/if}

<div class="recap-route">
	<div class="page">
		<RecapDetail
			{recap}
			loading={controller.loading}
			period={recap?.period}
			{onBack}
			stream={controller.stream}
			archive={recap ? archivePopover : undefined}
		/>
	</div>

	{#snippet archivePopover()}
		{#if recap}
			<RecapArchivePopover
				{repoId}
				period={recap.period}
				recaps={repoRecaps.list}
				activeRecapId={recapId}
				initialDayKey={utcDayKey(recap.periodStart)}
			/>
		{/if}
	{/snippet}
</div>

<style>
	.recap-route {
		position: relative;
		height: 100%;
		overflow: hidden;
	}

	.page {
		height: 100%;
		overflow-y: auto;
	}

</style>
