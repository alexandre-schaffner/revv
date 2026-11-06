<script lang="ts">
import { untrack } from "svelte";
import { goto } from "$app/navigation";
import { page } from "$app/state";
import { useShellChrome } from "$lib/components/layout/shell-chrome.svelte";
import { utcDayKey } from "$lib/components/recaps/period-window";
import RecapActions from "$lib/components/recaps/RecapActions.svelte";
import RecapArchivePopover from "$lib/components/recaps/RecapArchivePopover.svelte";
import RecapDetail from "$lib/components/recaps/RecapDetail.svelte";
import { RecapController } from "$lib/components/recaps/recap-controller.svelte";
import { fetchRecapsForRepo, getRecapsForRepo } from "$lib/stores/recaps.svelte";

const repoId = $derived(page.params.repoId ?? "");
const recapId = $derived(page.params.recapId ?? "");

const controller = new RecapController(
  () => repoId,
  () => recapId || null,
);
const recap = $derived(controller.recap);

// Hydrate the repo's recap list for the archive popover. Cached after the
// first load — SSE reducers in recaps.svelte.ts keep it fresh.
$effect(() => {
  const id = repoId;
  if (id) {
    void untrack(() => fetchRecapsForRepo(id));
  }
});

const recaps = $derived(getRecapsForRepo(repoId));

useShellChrome(() => ({
  actions:
    recap && (controller.offersCurrentWindow || controller.actionState) ? recapActions : undefined,
}));

function onBack(): void {
  void goto(`/repo/${repoId}/recaps`);
}
</script>

{#snippet recapActions()}
	{#if recap}
		<RecapActions
			{controller}
			period={recap.period}
			ongenerated={(id) => void goto(`/repo/${repoId}/recaps/${id}`)}
		/>
	{/if}
{/snippet}

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
				{recaps}
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
