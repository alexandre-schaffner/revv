<script lang="ts">
import Sparkles from "phosphor-svelte/lib/Sparkle";
import Loader2 from "phosphor-svelte/lib/Spinner";
import { untrack } from "svelte";
import { goto } from "$app/navigation";
import { page } from "$app/state";
import { Shimmer } from "$lib/components/ai/shimmer";
import AuthGuard from "$lib/components/auth/AuthGuard.svelte";
import GenActionBar, { type GenActionState } from "$lib/components/layout/GenActionBar.svelte";
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
  generateRecap,
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

let generating = $state(false);

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

const periodLabelLower = $derived(recap?.period === "weekly" ? "weekly" : "daily");
const currentPeriodLabel = $derived(recap?.period === "weekly" ? "this week's" : "today's");

function utcDayKey(iso: string | Date): string {
  const s = typeof iso === "string" ? iso : iso.toISOString();
  return s.slice(0, 10);
}

function utcDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function utcMondayKey(d: Date): string {
  const daysFromMonday = (d.getUTCDay() + 6) % 7;
  const mondayMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - daysFromMonday);
  return new Date(mondayMs).toISOString().slice(0, 10);
}

function isClosedFullPeriod(r: NonNullable<typeof recap>): boolean {
  const start = new Date(r.periodStart).getTime();
  const end = new Date(r.periodEnd).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  const duration = r.period === "daily" ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
  return end - start === duration;
}

function recapIsOutOfDate(r: NonNullable<typeof recap>): boolean {
  if (r.status !== "complete") return false;
  if (isClosedFullPeriod(r)) return true;
  if (r.period === "daily") {
    return utcDayKey(r.periodStart) !== utcDateKey(new Date());
  }
  return utcDayKey(r.periodStart) !== utcMondayKey(new Date());
}

type RecapUiKind = "generating" | "stopped" | "error" | "complete" | "outdated" | "hidden";

const recapUiKind: RecapUiKind = $derived.by(() => {
  if (!recap) return "hidden";
  if (recap.status === "generating") return "generating";
  if (recap.status === "error") {
    return recap.errorMessage === "Cancelled by user" ? "stopped" : "error";
  }
  if (recap.status === "complete") return recapIsOutOfDate(recap) ? "outdated" : "complete";
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
    case "outdated":
      return { kind: "stale", label: "Rerun this recap" };
    default:
      return null;
  }
});

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

		{#if genActionState}
			<div class="actions-float">
				<div class="actions-row">
					{#if recapUiKind === "outdated"}
						<GlassPill
							variant="accent"
							onclick={onGenerate}
							disabled={generating}
							title="Write a brand-new recap for {currentPeriodLabel} {periodLabelLower} window. The recap below stays as-is."
						>
							{#if generating}
								<Loader2 size={14} weight="regular" class="animate-spin" aria-hidden="true" />
							{:else}
								<Sparkles size={16} weight="fill" aria-hidden="true" />
							{/if}
							<Shimmer active={!generating}>
								{generating
									? `Generating ${currentPeriodLabel} recap…`
									: `Generate ${currentPeriodLabel} recap`}
							</Shimmer>
						</GlassPill>
					{/if}
					<GenActionBar
						uiState={genActionState}
						pendingAction={pendingAction}
						{onStop}
						onResume={onRegenerate}
						onRegenerate={onRegenerate}
					/>
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
</style>
