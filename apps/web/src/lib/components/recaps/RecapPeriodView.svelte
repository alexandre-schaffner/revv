<script lang="ts">
import { Loader2, Play, RefreshCw, RotateCcw, Sparkles, Square } from "@lucide/svelte";
import type { ProjectRecap, ProjectRecapSummary, RecapPeriod } from "@revv/shared";
import { untrack } from "svelte";
import { Shimmer } from "$lib/components/ai/shimmer";
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
import GlassPill from "$lib/components/ui/glass-pill/GlassPill.svelte";
import PreviousRecaps from "./PreviousRecaps.svelte";
import RecapDetail from "./RecapDetail.svelte";

interface Props {
  repoId: string;
  period: RecapPeriod;
}

let { repoId, period }: Props = $props();

let generating = $state(false);

const periodLabel = $derived(period === "daily" ? "Daily" : "Weekly");
const periodLabelLower = $derived(period === "daily" ? "daily" : "weekly");
// Label used in the "out of date" CTA so it reads as a fresh recap for the
// user's current period, not a regeneration of the displayed one.
const currentPeriodLabel = $derived(period === "daily" ? "today's" : "this week's");

// Fetch the recap list for this repo. The list reducer hydrates from WS
// envelopes so navigating between periods doesn't re-hit the network.
$effect(() => {
  const id = repoId;
  if (id) {
    void untrack(() => fetchRecapsForRepo(id));
  }
});

const recaps = $derived(getRecapsForRepo(repoId));
const listLoading = $derived(getRecapLoading(repoId));

// Latest non-superseded recap for this period. The store keeps the list
// newest-first by generatedAt, so the first match is the most recent.
const latest = $derived<ProjectRecapSummary | null>(
  recaps.find((r) => r.period === period && r.status !== "superseded") ?? null,
);
const latestId = $derived(latest?.id ?? null);

// Hydrate the full markdown for the latest recap whenever the id changes.
// The summary list lacks `overview`, so RecapDetail needs the detail row.
$effect(() => {
  const id = latestId;
  if (id) {
    void untrack(() => loadRecap(id));
  }
});

const latestDetail = $derived<ProjectRecap | null>(latestId ? getRecapDetail(latestId) : null);
const detailLoading = $derived(latestId ? getRecapDetailLoading(latestId) : false);
const stream = $derived(latestId ? getRecapStreamEntry(latestId) : null);
const pendingAction = $derived(latestId ? getRecapPendingAction(latestId) : null);

// Auto-stream when the latest recap is still generating.
$effect(() => {
  const id = latestId;
  const r = latestDetail;
  if (id && r?.status === "generating") {
    void streamRecap(id);
  }
});

// Cleanup any stream we started when navigating away or switching ids.
$effect(() => {
  const id = latestId;
  return () => {
    if (id) {
      abortRecapStream(id);
    }
  };
});

// Editorial mono eyebrow — current period in UTC. ISO week (Mon → now)
// for weekly, today's UTC date for daily. Matches the server's
// `manualWeeklyBoundaries` window.
const DAY_FMT = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "2-digit",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
const DAY_SHORT_FMT = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  timeZone: "UTC",
});

const periodEyebrow = $derived.by(() => {
  const now = new Date();
  if (period === "daily") {
    return `${DAY_FMT.format(now)} · UTC`;
  }
  const dow = now.getUTCDay();
  const daysFromMonday = (dow + 6) % 7;
  const start = new Date(now.getTime() - daysFromMonday * 24 * 60 * 60 * 1000);
  return `${DAY_SHORT_FMT.format(start)} → ${DAY_SHORT_FMT.format(now)} · UTC`;
});

// "Out of date" is computed against the user's LOCAL calendar, not UTC. The
// server windows are UTC-aligned, but from the user's perspective a recap
// labelled "Mon, 18 May · UTC" is stale once their wall clock reads May 19,
// even if UTC hasn't rolled over yet. Clicking Generate will let the server
// produce whatever the current UTC window dictates.
function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function utcDayKey(iso: string): string {
  return iso.slice(0, 10);
}

function localMondayKey(d: Date): string {
  const daysFromMonday = (d.getDay() + 6) % 7;
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - daysFromMonday);
  return dayKey(monday);
}

const isOutOfDate = $derived.by(() => {
  if (latest === null || latest.status !== "complete") return false;
  if (period === "daily") {
    return utcDayKey(latest.periodStart) !== dayKey(new Date());
  }
  // Weekly: a recap's periodStart is the Monday of its UTC week. Compare
  // that to the Monday of the user's current local week.
  return utcDayKey(latest.periodStart) !== localMondayKey(new Date());
});

type RecapUiKind = "generating" | "stopped" | "error" | "complete" | "outdated" | "hidden";

const recapUiKind: RecapUiKind = $derived.by(() => {
  if (!latestDetail) return "hidden";
  if (latestDetail.status === "generating") return "generating";
  if (latestDetail.status === "error") {
    return latestDetail.errorMessage === "Cancelled by user" ? "stopped" : "error";
  }
  if (latestDetail.status === "complete") return isOutOfDate ? "outdated" : "complete";
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

// Show the floating Generate pill when there's no recap yet.
// When a recap exists, show the Regenerate/Stop/Resume bar instead.
const showGenerateFab = $derived(!latestDetail);

async function onGenerate(): Promise<void> {
  if (generating) return;
  generating = true;
  try {
    await generateRecap(repoId, period);
  } finally {
    generating = false;
  }
}

async function onRegenerate(): Promise<void> {
  const id = latestId;
  if (!id) return;
  resetRecapStream(id);
  await regenerateRecap(id);
}

async function onStop(): Promise<void> {
  const id = latestId;
  if (!id) return;
  await stopRecap(id);
}
</script>

<div class="period-view">
	{#if latestDetail}
		<RecapDetail
			recap={latestDetail}
			loading={detailLoading}
			{stream}
		/>
	{:else if latest && detailLoading}
		<div class="period-loading">
			<Loader2 size={20} class="animate-spin" aria-hidden="true" />
			<p>Loading {periodLabelLower} recap…</p>
		</div>
	{:else if listLoading && recaps.length === 0}
		<div class="period-loading">
			<Loader2 size={20} class="animate-spin" aria-hidden="true" />
			<p>Loading recaps…</p>
		</div>
	{:else}
		<header class="period-hero">
			<span class="period-eyebrow">{periodEyebrow}</span>
			<h1 class="period-title">{periodLabel} recap</h1>
			<p class="period-lede">
				{#if period === "daily"}
					A snapshot of every pull request that opened, moved, or shipped
					today — written by the agent, ready in a minute.
				{:else}
					A week of pull-request activity distilled into one read — what
					shipped, what's still in flight, where the risk sits.
				{/if}
			</p>
		</header>
	{/if}

	<PreviousRecaps
		{repoId}
		{period}
		{recaps}
		loading={listLoading}
		excludeRecapId={latestId}
	/>
</div>

{#if showGenerateFab || recapUiKind !== 'hidden'}
	<div class="recap-actions-float">
		<div class="recap-actions-row">
			{#if showGenerateFab}
				<GlassPill
					variant="accent"
					onclick={onGenerate}
					disabled={generating}
					title="Have the agent write a fresh {periodLabelLower} recap"
				>
					{#if generating}
						<Loader2 size={14} class="animate-spin" aria-hidden="true" />
					{:else}
						<Sparkles size={14} aria-hidden="true" />
					{/if}
					<Shimmer active={!generating}>
						{generating
							? `Generating ${periodLabelLower} recap…`
							: `Generate ${periodLabelLower} recap`}
					</Shimmer>
				</GlassPill>
			{:else if recapUiKind === 'generating'}
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
			{:else if recapUiKind === 'outdated'}
				<GlassPill
					variant="accent"
					onclick={onGenerate}
					disabled={generating}
					title="Write a brand-new recap for {currentPeriodLabel} {periodLabelLower} window. The recap below stays as-is."
				>
					{#if generating}
						<Loader2 size={14} class="animate-spin" aria-hidden="true" />
					{:else}
						<Sparkles size={14} aria-hidden="true" />
					{/if}
					<Shimmer active={!generating}>
						{generating ? `Generating ${currentPeriodLabel} recap…` : `Generate ${currentPeriodLabel} recap`}
					</Shimmer>
				</GlassPill>
				<GlassPill
					disabled={destructiveDisabled}
					title={destructiveTitle ?? 'Replace this recap with a fresh run over the same past window (old version becomes superseded)'}
					onclick={onRegenerate}
				>
					<RefreshCw size={14} />
					Rerun this recap
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

<style>
	.period-view {
		display: flex;
		flex-direction: column;
		max-width: 56rem;
		margin: 0 auto;
		width: 100%;
		padding: 1rem 1.25rem 4rem;
	}

	.period-loading {
		display: flex;
		gap: 0.625rem;
		align-items: center;
		padding: 1rem 1.25rem;
		background: var(--color-bg-secondary);
		border-radius: 0.5rem;
		color: var(--color-text-secondary);
	}

	.period-loading p {
		margin: 0;
	}

	/* Editorial empty state. Mono eyebrow → display heading → lede.
	   Sized to feel like a magazine landing, not a settings card. */
	.period-hero {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		padding: 3.5rem 0.25rem 1.5rem;
	}

	.period-eyebrow {
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		font-weight: 500;
		text-transform: uppercase;
		letter-spacing: 0.18em;
		color: var(--color-text-muted);
	}

	.period-title {
		margin: 0;
		font-size: clamp(2rem, 4vw, 2.75rem);
		font-weight: 500;
		letter-spacing: -0.035em;
		line-height: 1.02;
		color: var(--color-text-primary);
	}

	.period-lede {
		margin: 0.25rem 0 0;
		font-size: 0.9375rem;
		line-height: 1.55;
		color: var(--color-text-secondary);
		max-width: 34rem;
	}

	/* Bottom-anchored action bar — same structure and values as
	   .walkthrough-actions-float in AppShell. Positioned relative to the
	   nearest ancestor with `position: relative` — the page wrapper that
	   each route provides outside the scroll container. */
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
