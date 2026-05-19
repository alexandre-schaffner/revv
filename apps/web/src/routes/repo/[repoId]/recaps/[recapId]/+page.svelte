<script lang="ts">
import { untrack } from "svelte";
import { goto } from "$app/navigation";
import { page } from "$app/state";
import { Play, RefreshCw, RotateCcw, Square } from "@lucide/svelte";
import AuthGuard from "$lib/components/auth/AuthGuard.svelte";
import PreviousRecaps from "$lib/components/recaps/PreviousRecaps.svelte";
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
  getRecapDetail,
  getRecapDetailLoading,
  getRecapLoading,
  getRecapPendingAction,
  getRecapsForRepo,
  loadRecap,
  regenerateRecap,
  stopRecap,
} from "$lib/stores/recaps.svelte";
const repoId = $derived(page.params.repoId ?? "");
const recapId = $derived(page.params.recapId ?? "");

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
const pendingAction = $derived(getRecapPendingAction(recapId));

type RecapUiKind = "generating" | "stopped" | "error" | "complete" | "hidden";

const recapUiKind: RecapUiKind = $derived.by(() => {
  if (!recap) return "hidden";
  if (recap.status === "generating") return "generating";
  if (recap.status === "error") {
    return recap.errorMessage === "Cancelled by user" ? "stopped" : "error";
  }
  if (recap.status === "complete") return "complete";
  return "hidden";
});

const destructiveDisabled = $derived(pendingAction !== null);
const destructiveTitle = $derived(
  pendingAction === "regenerate"
    ? "Regenerating…"
    : pendingAction === "stop"
      ? "Stopping…"
      : undefined,
);

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
</script>

<AuthGuard>
	<div class="recap-page">
		<div class="page">
			<div class="container">
				<RecapDetail
					{recap}
					{loading}
					{onBack}
					{stream}
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

		{#if recapUiKind !== 'hidden'}
			<div class="recap-actions-float">
				<div class="recap-actions-row">
					{#if recapUiKind === 'generating'}
						<GlassPill
							variant="danger"
							onclick={onStop}
							disabled={pendingAction === 'stop'}
							title={pendingAction === 'stop' ? 'Stopping…' : 'Stop this recap generation'}
						>
							<Square size={14} fill="currentColor" />
							{pendingAction === 'stop' ? 'Stopping…' : 'Stop generation'}
						</GlassPill>
					{:else if recapUiKind === 'stopped'}
						<GlassPill
							disabled={destructiveDisabled}
							title={destructiveTitle ?? 'Resume generation from where it was stopped'}
							onclick={onRegenerate}
							aria-label="Resume recap generation"
						>
							<Play size={14} fill="currentColor" />
							Resume
						</GlassPill>
						<GlassPill
							disabled={destructiveDisabled}
							title={destructiveTitle ?? 'Generate a fresh recap (the current draft will be replaced)'}
							onclick={onRegenerate}
						>
							<RefreshCw size={14} />
							Regenerate
						</GlassPill>
					{:else if recapUiKind === 'error'}
						<GlassPill
							disabled={destructiveDisabled}
							title={destructiveTitle ?? 'Retry recap generation after error'}
							onclick={onRegenerate}
							aria-label="Retry recap generation"
						>
							<RotateCcw size={14} />
							Retry
						</GlassPill>
						<GlassPill
							disabled={destructiveDisabled}
							title={destructiveTitle ?? 'Generate a fresh recap (the current draft will be replaced)'}
							onclick={onRegenerate}
						>
							<RefreshCw size={14} />
							Regenerate
						</GlassPill>
					{:else if recapUiKind === 'complete'}
						<GlassPill
							disabled={destructiveDisabled}
							title={destructiveTitle ?? 'Generate a fresh recap for this period (the current one becomes superseded)'}
							onclick={onRegenerate}
						>
							<RefreshCw size={14} />
							Regenerate recap
						</GlassPill>
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
	.recap-page {
		position: relative;
		height: 100%;
		overflow: hidden;
	}

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
		padding: 1rem 1.25rem 4rem;
	}

	/* Bottom-anchored action bar — same structure and values as
	   .walkthrough-actions-float in AppShell so both pages behave
	   identically. pointer-events: none on the wrapper so clicks reach
	   content in the transparent zone around the pills. */
	.recap-actions-float {
		position: absolute;
		bottom: 0;
		left: 0;
		right: 0;
		display: flex;
		justify-content: center;
		padding: 8px 0 10px;
		z-index: 10;
		pointer-events: none;
	}

	.recap-actions-float :global(*) {
		pointer-events: auto;
	}

	.recap-actions-row {
		display: inline-flex;
		align-items: center;
		gap: var(--spacing-island);
	}
</style>
