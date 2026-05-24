<script lang="ts">
import type { ProjectRecap, ProjectRecapSummary, RecapPeriod } from "@revv/shared";
import Sparkles from "phosphor-svelte/lib/Sparkle";
import Loader2 from "phosphor-svelte/lib/Spinner";
import { untrack } from "svelte";
import { Shimmer } from "$lib/components/ai/shimmer";
import GenActionBar, { type GenActionState } from "$lib/components/layout/GenActionBar.svelte";
import GlassPill from "$lib/components/ui/glass-pill/GlassPill.svelte";
import { gsapFade, gsapFadeY, setupFlipOnChange, tokens } from "$lib/motion";
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
import PreviousRecaps from "./PreviousRecaps.svelte";
import RecapDetail from "./RecapDetail.svelte";

interface Props {
  repoId: string;
  period: RecapPeriod;
}

let { repoId, period }: Props = $props();

let generating = $state(false);
const refreshedCompletedStreamIds: Record<string, true> = {};

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

// SSE `done` should reveal the final persisted markdown even if the WS
// completion broadcast arrives late or was missed while reconnecting.
$effect(() => {
  const id = latestId;
  if (!id || !stream?.doneReceived || refreshedCompletedStreamIds[id]) return;
  refreshedCompletedStreamIds[id] = true;
  void untrack(async () => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await loadRecap(id);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await loadRecap(id);
  });
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

function isClosedFullPeriod(r: ProjectRecap): boolean {
  const start = new Date(r.periodStart).getTime();
  const end = new Date(r.periodEnd).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  const duration = r.period === "daily" ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
  return end - start === duration;
}

function recapIsOutOfDate(r: ProjectRecap): boolean {
  if (r.status !== "complete") return false;
  if (isClosedFullPeriod(r)) return true;
  if (r.period === "daily") {
    return utcDayKey(r.periodStart) !== utcDateKey(new Date());
  }
  // Weekly windows are labelled and generated in UTC, so compare against
  // the current UTC week's Monday.
  return utcDayKey(r.periodStart) !== utcMondayKey(new Date());
}

type RecapUiKind = "generating" | "stopped" | "error" | "complete" | "outdated" | "hidden";

const recapUiKind: RecapUiKind = $derived.by(() => {
  if (!latestDetail) return "hidden";
  if (latestDetail.status === "generating") return "generating";
  if (latestDetail.status === "error") {
    return latestDetail.errorMessage === "Cancelled by user" ? "stopped" : "error";
  }
  if (latestDetail.status === "complete")
    return recapIsOutOfDate(latestDetail) ? "outdated" : "complete";
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

// Show the floating Generate pill when there's no recap yet.
// When a recap exists, show the Regenerate/Stop/Resume bar instead.
const showGenerateFab = $derived(!latestDetail);

// Flip ride for the GenActionBar swap: when the central pill changes width
// (Stop → Regenerate, etc.), the surviving siblings (the outdated-CTA pill)
// slide to their new positions instead of jumping.
let actionsRowEl = $state<HTMLDivElement | null>(null);
setupFlipOnChange(
  () => actionsRowEl,
  () => genActionState?.kind,
);

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
			<Loader2 size={20} weight="regular" class="motion-essential-spin" aria-hidden="true" />
			<p>Loading {periodLabelLower} recap…</p>
		</div>
	{:else if listLoading && recaps.length === 0}
		<div class="period-loading">
			<Loader2 size={20} weight="regular" class="motion-essential-spin" aria-hidden="true" />
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

{#if showGenerateFab || genActionState}
	<div
		class="actions-float"
		in:gsapFadeY={{ duration: tokens.quick, y: 8 }}
		out:gsapFade={{ duration: tokens.snap }}
	>
		<div
			bind:this={actionsRowEl}
			class="actions-row"
			role="toolbar"
			aria-label="Recap actions"
		>
			{#if showGenerateFab}
				<GlassPill
					variant="accent"
					onclick={onGenerate}
					disabled={generating}
					title="Have the agent write a fresh {periodLabelLower} recap"
				>
					{#if generating}
						<Loader2 size={14} weight="regular" class="motion-essential-spin" aria-hidden="true" />
					{:else}
						<Sparkles size={16} weight="fill" aria-hidden="true" />
					{/if}
					<Shimmer active={!generating}>
						{generating
							? `Generating ${periodLabelLower} recap…`
							: `Generate ${periodLabelLower} recap`}
					</Shimmer>
				</GlassPill>
			{/if}

			{#if recapUiKind === 'outdated'}
				<GlassPill
					variant="accent"
					onclick={onGenerate}
					disabled={generating}
					title="Write a brand-new recap for {currentPeriodLabel} {periodLabelLower} window. The recap below stays as-is."
				>
					{#if generating}
						<Loader2 size={14} weight="regular" class="motion-essential-spin" aria-hidden="true" />
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
</style>
