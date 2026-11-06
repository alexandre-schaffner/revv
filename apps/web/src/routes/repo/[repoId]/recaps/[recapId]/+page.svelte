<script lang="ts">
import { untrack } from "svelte";
import { goto } from "$app/navigation";
import { page } from "$app/state";
import AuthGuard from "$lib/components/auth/AuthGuard.svelte";
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

function onBack(): void {
  void goto(`/repo/${repoId}/recaps`);
}
</script>

<AuthGuard>
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

		{#if recap}
			<RecapActions
				{controller}
				period={recap.period}
				ongenerated={(id) => void goto(`/repo/${repoId}/recaps/${id}`)}
			/>
		{/if}
	</div>
</AuthGuard>

<style>
	/* Positioning context for the floating action bar — mirrors the role
	   .main-area plays for the PR walkthrough actions in AppShell. The
	   scroll container (.page) lives inside this wrapper so the absolutely
	   positioned bar is never a descendant of the scroll container. */
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
