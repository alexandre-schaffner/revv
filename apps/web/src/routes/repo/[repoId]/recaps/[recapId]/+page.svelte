<script lang="ts">
import { goto } from "$app/navigation";
import { page } from "$app/state";
import AuthGuard from "$lib/components/auth/AuthGuard.svelte";
import RecapDetail from "$lib/components/recaps/RecapDetail.svelte";
import {
  getRecapDetail,
  getRecapDetailLoading,
  loadRecap,
  regenerateRecap,
} from "$lib/stores/recaps.svelte";

const repoId = $derived(page.params.repoId ?? "");
const recapId = $derived(page.params.recapId ?? "");

let regenerating = $state(false);

$effect(() => {
  if (recapId) void loadRecap(recapId);
});

const recap = $derived(getRecapDetail(recapId));
const loading = $derived(getRecapDetailLoading(recapId));

function onBack(): void {
  void goto(`/repo/${repoId}/recaps`);
}

async function onRegenerate(): Promise<void> {
  if (regenerating) return;
  regenerating = true;
  try {
    await regenerateRecap(recapId);
  } finally {
    regenerating = false;
  }
}
</script>

<AuthGuard>
	<div class="page">
		<RecapDetail {recap} {loading} {onBack} {onRegenerate} {regenerating} />
	</div>
</AuthGuard>

<style>
	.page {
		height: 100%;
		overflow-y: auto;
	}
</style>
