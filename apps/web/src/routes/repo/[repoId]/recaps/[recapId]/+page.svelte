<script lang="ts">
import { untrack } from "svelte";
import { goto } from "$app/navigation";
import { page } from "$app/state";
import AuthGuard from "$lib/components/auth/AuthGuard.svelte";
import PreviousRecaps from "$lib/components/recaps/PreviousRecaps.svelte";
import RecapDetail from "$lib/components/recaps/RecapDetail.svelte";
import {
  abortRecapStream,
  getRecapStreamEntry,
  resetRecapStream,
  streamRecap,
} from "$lib/stores/recap-stream.svelte";
import {
  fetchRecapsForRepo,
  getRecapDetail,
  getRecapDetailLoading,
  getRecapLoading,
  getRecapsForRepo,
  loadRecap,
  regenerateRecap,
} from "$lib/stores/recaps.svelte";
import {
  getRightPanelOpen,
  getRightPanelWidth,
  getSidebarCollapsed,
  getSidebarPeekHovering,
  getSidebarWidth,
} from "$lib/stores/sidebar.svelte";

const RAIL_WIDTH = 64;

const repoId = $derived(page.params.repoId ?? "");
const recapId = $derived(page.params.recapId ?? "");

let regenerating = $state(false);

// Mirror AppShell.floatingActionsStyle so RecapDetail's Regenerate pill
// centres over the visible main area (between sidebar and any right
// panel), not the full viewport.
const sidebarCollapsed = $derived(getSidebarCollapsed());
const sidebarPeekHovering = $derived(getSidebarPeekHovering());
const sidebarEffectiveCollapsed = $derived(sidebarCollapsed && !sidebarPeekHovering);
const sidebarWidth = $derived(getSidebarWidth());
const rightPanelOpen = $derived(getRightPanelOpen());
const rightPanelWidth = $derived(getRightPanelWidth());
const floatingActionsStyle = $derived(
  `left: ${RAIL_WIDTH + (sidebarEffectiveCollapsed ? 0 : sidebarWidth)}px; right: ${
    rightPanelOpen ? rightPanelWidth : 0
  }px;`,
);

$effect(() => {
  const id = recapId;
  if (id) {
    void untrack(() => loadRecap(id));
  }
});

// Hydrate the repo's recap list so the "Previous recaps" section below
// has data to render. Cached after the first load — WS reducers in
// recaps.svelte.ts keep it fresh.
$effect(() => {
  const id = repoId;
  if (id) {
    void untrack(() => fetchRecapsForRepo(id));
  }
});

// Start SSE stream when the recap is generating.
$effect(() => {
  const id = recapId;
  const r = recap;
  if (id && r?.status === "generating") {
    void streamRecap(id);
  }
});

// Cleanup stream on unmount or when recapId changes.
$effect(() => {
  const id = recapId;
  return () => {
    if (id) {
      abortRecapStream(id);
    }
  };
});

const recap = $derived(getRecapDetail(recapId));
const loading = $derived(getRecapDetailLoading(recapId));
const stream = $derived(getRecapStreamEntry(recapId));
const recaps = $derived(getRecapsForRepo(repoId));
const listLoading = $derived(getRecapLoading(repoId));

function onBack(): void {
  void goto(`/repo/${repoId}/recaps`);
}

async function onRegenerate(): Promise<void> {
  if (regenerating) return;
  regenerating = true;
  try {
    resetRecapStream(recapId);
    const result = await regenerateRecap(recapId);
    if (result?.recapId && result.recapId !== recapId) {
      void goto(`/repo/${repoId}/recaps/${result.recapId}`);
    }
  } finally {
    regenerating = false;
  }
}
</script>

<AuthGuard>
	<div class="page">
		<div class="container">
			<RecapDetail
				{recap}
				{loading}
				{onBack}
				{onRegenerate}
				{regenerating}
				{stream}
				{floatingActionsStyle}
			/>
			{#if recap}
				<PreviousRecaps
					{repoId}
					period={recap.period}
					{recaps}
					loading={listLoading}
					excludeRecapId={recapId}
				/>
			{/if}
		</div>
	</div>
</AuthGuard>

<style>
	.page {
		height: 100%;
		overflow-y: auto;
	}

	.container {
		display: flex;
		flex-direction: column;
		max-width: 56rem;
		margin: 0 auto;
		width: 100%;
		/* Bottom padding clears the floating Regenerate pill
		   (36px button + 40px bottom offset + 12px padding). */
		padding: 1rem 1.25rem 7rem;
	}
</style>
