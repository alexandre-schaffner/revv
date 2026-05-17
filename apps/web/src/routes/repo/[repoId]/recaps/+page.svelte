<script lang="ts">
import type { RecapPeriod } from "@revv/shared";
import { page } from "$app/state";
import AuthGuard from "$lib/components/auth/AuthGuard.svelte";
import RecapList from "$lib/components/recaps/RecapList.svelte";
import {
  fetchRecapsForRepo,
  generateRecap,
  getRecapLoading,
  getRecapsForRepo,
} from "$lib/stores/recaps.svelte";

const repoId = $derived(page.params.repoId ?? "");

let activePeriod = $state<RecapPeriod | "all">("all");
let generating = $state(false);

// Fetch the recap list when this page is mounted / the repoId changes.
// WS reducers in recaps.svelte.ts keep the data fresh while we're on
// this page.
$effect(() => {
  if (repoId) void fetchRecapsForRepo(repoId);
});

const recaps = $derived(getRecapsForRepo(repoId));
const loading = $derived(getRecapLoading(repoId));

async function onGenerate(period: RecapPeriod): Promise<void> {
  if (generating) return;
  generating = true;
  try {
    await generateRecap(repoId, period);
  } finally {
    generating = false;
  }
}
</script>

<AuthGuard>
	<div class="page">
		<RecapList
			{repoId}
			{recaps}
			{loading}
			{activePeriod}
			onSetPeriod={(p) => (activePeriod = p)}
			{onGenerate}
			{generating}
		/>
	</div>
</AuthGuard>

<style>
	.page {
		height: 100%;
		overflow-y: auto;
	}
</style>
