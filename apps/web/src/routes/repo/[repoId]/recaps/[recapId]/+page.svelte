<script lang="ts">
import PenNib from "phosphor-svelte/lib/PenNib";
import Spinner from "phosphor-svelte/lib/Spinner";
import { untrack } from "svelte";
import { goto } from "$app/navigation";
import { page } from "$app/state";
import { Shimmer } from "$lib/components/ai/shimmer";
import AuthGuard from "$lib/components/auth/AuthGuard.svelte";
import GenActionBar, { type GenActionState } from "$lib/components/layout/GenActionBar.svelte";
import { recapWindowIsStale, utcDayKey } from "$lib/components/recaps/period-window";
import RecapArchivePopover from "$lib/components/recaps/RecapArchivePopover.svelte";
import RecapDetail from "$lib/components/recaps/RecapDetail.svelte";
import GlassPill from "$lib/components/ui/glass-pill/GlassPill.svelte";
import {
  abortRecapStream,
  getRecapStreamEntry,
  resetRecapStream,
  streamRecap,
} from "$lib/stores/recap-stream.svelte";
import {
  fetchRecapsForRepo,
  generateRecap,
  getRecapDetail,
  getRecapDetailLoading,
  getRecapPendingAction,
  getRecapsForRepo,
  loadRecap,
  regenerateRecap,
  stopRecap,
} from "$lib/stores/recaps.svelte";
import { getActionsFloatStyle } from "$lib/stores/sidebar.svelte";

const repoId = $derived(page.params.repoId ?? "");
const recapId = $derived(page.params.recapId ?? "");

let generating = $state(false);

$effect(() => {
  const id = recapId;
  if (id) {
    void untrack(() => loadRecap(id));
  }
});

// Hydrate the repo's recap list so the "Previous recaps" section below
// has data to render. Cached after the first load — SSE reducers in
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
const pendingAction = $derived(getRecapPendingAction(recapId));

const actionsFloatStyle = $derived(getActionsFloatStyle());

const periodLabelLower = $derived(recap?.period === "weekly" ? "weekly" : "daily");
const currentPeriodLabel = $derived(recap?.period === "weekly" ? "this week's" : "today's");

// Whether this recap still covers the current day/week window.
const recapIsStale = $derived(recap ? recapWindowIsStale(recap) : false);

type RecapUiKind = "generating" | "stopped" | "error" | "complete" | "outdated" | "hidden";

const recapUiKind: RecapUiKind = $derived.by(() => {
  if (!recap) return "hidden";
  if (recap.status === "generating") return "generating";
  if (recap.status === "error") {
    return recap.errorMessage === "Cancelled by user" ? "stopped" : "error";
  }
  if (recap.status === "complete") return recapIsStale ? "outdated" : "complete";
  return "hidden";
});

/** Map recap-specific state to the normalised GenActionState. */
const genActionState = $derived.by((): GenActionState | null => {
  switch (recapUiKind) {
    case "generating":
      return { kind: "streaming" };
    case "stopped":
      return { kind: "resumable" };
    case "error":
      return { kind: "error" };
    case "complete":
      return { kind: "complete" };
    // Rerunning a past window is only offered here — see RecapPeriodView.
    case "outdated":
      return { kind: "stale", label: "Rerun this recap" };
    default:
      return null;
  }
});

// Offer a fresh-period CTA whenever this recap covers a past window —
// whatever its status. A stopped or errored recap from an earlier week
// otherwise leaves only Resume/Regenerate, which both re-run *that* window.
const showGenerateFab = $derived(!!recap && recapIsStale && recap.status !== "generating");

function onBack(): void {
  void goto(`/repo/${repoId}/recaps`);
}

async function onRegenerate(): Promise<void> {
  resetRecapStream(recapId);
  const result = await regenerateRecap(recapId);
  if (result?.recapId && result.recapId !== recapId) {
    void goto(`/repo/${repoId}/recaps/${result.recapId}`);
  }
}

async function onStop(): Promise<void> {
  await stopRecap(recapId);
}

async function onGenerate(): Promise<void> {
  if (generating || !recap) return;
  generating = true;
  try {
    const result = await generateRecap(repoId, recap.period);
    if (result?.recapId) {
      void goto(`/repo/${repoId}/recaps/${result.recapId}`);
    }
  } finally {
    generating = false;
  }
}
</script>

<AuthGuard>
	<div class="recap-route">
		<div class="page">
			<RecapDetail
				{recap}
				{loading}
				period={recap?.period}
				{onBack}
				{stream}
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

		{#if showGenerateFab || genActionState}
			<div class="actions-float" style={actionsFloatStyle}>
				<div class="actions-row" role="toolbar" aria-label="Recap actions">
					{#if showGenerateFab}
						<GlassPill
							variant="accent"
							onclick={onGenerate}
							disabled={generating}
							title="Write a brand-new recap for {currentPeriodLabel} {periodLabelLower} window. The recap below stays as-is."
						>
							{#if generating}
								<Spinner size={14} class="motion-essential-spin" aria-hidden="true" />
							{:else}
								<PenNib size={16} aria-hidden="true" />
							{/if}
							<Shimmer active={!generating}>
								{generating
									? `Generating ${currentPeriodLabel} recap…`
									: `Generate ${currentPeriodLabel} recap`}
							</Shimmer>
						</GlassPill>
					{/if}
					{#if genActionState}
						<GenActionBar
							uiState={genActionState}
							pendingAction={pendingAction}
							{onStop}
							onResume={onRegenerate}
							onRegenerate={onRegenerate}
						/>
					{/if}
				</div>
			</div>
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
