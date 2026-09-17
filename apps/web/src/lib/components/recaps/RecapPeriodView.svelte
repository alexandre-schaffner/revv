<script lang="ts">
import type { ProjectRecap, ProjectRecapSummary, RecapPeriod } from "@revv/shared";
import PenNib from "phosphor-svelte/lib/PenNib";
import Spinner from "phosphor-svelte/lib/Spinner";
import { untrack } from "svelte";
import { goto } from "$app/navigation";
import { Shimmer } from "$lib/components/ai/shimmer";
import GenActionBar, { type GenActionState } from "$lib/components/layout/GenActionBar.svelte";
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
import { getActionsFloatStyle } from "$lib/stores/sidebar.svelte";
import DotMatrixLoader from "./DotMatrixLoader.svelte";
import { pickLatestByWindow, recapWindowIsStale } from "./period-window";
import RecapCalendar from "./RecapCalendar.svelte";
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

// Fetch the recap list for this repo. The list reducer hydrates from SSE
// envelopes so navigating between periods doesn't re-hit the network.
$effect(() => {
  const id = repoId;
  if (id) {
    void untrack(() => fetchRecapsForRepo(id));
  }
});

const recaps = $derived(getRecapsForRepo(repoId));
const listLoading = $derived(getRecapLoading(repoId));

// Latest non-superseded recap for this period — by *window*, not by
// generation time. Generating a recap for a day three weeks back would
// otherwise hijack this hero the moment it finished.
const latest = $derived<ProjectRecapSummary | null>(pickLatestByWindow(recaps, period));
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

// SSE `done` should reveal the final persisted markdown even if the
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

// Whether the newest recap still covers the current day/week window.
const latestIsStale = $derived(latestDetail ? recapWindowIsStale(latestDetail) : false);

type RecapUiKind = "generating" | "stopped" | "error" | "complete" | "outdated" | "hidden";

const recapUiKind: RecapUiKind = $derived.by(() => {
  if (!latestDetail) return "hidden";
  if (latestDetail.status === "generating") return "generating";
  if (latestDetail.status === "error") {
    return latestDetail.errorMessage === "Cancelled by user" ? "stopped" : "error";
  }
  if (latestDetail.status === "complete") return latestIsStale ? "outdated" : "complete";
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

// Show the floating Generate pill when there's no recap yet, or when the
// newest one covers a past window — whatever its status. A stopped or errored
// recap from an earlier week otherwise leaves only Resume/Regenerate, which
// both re-run *that* window; there'd be no way to ask for the current one.
// While a generation is in flight the bar's Stop is the only sensible action.
const showGenerateFab = $derived(
  !latestDetail || (latestIsStale && latestDetail.status !== "generating"),
);

// "Generate weekly recap" for a first run; "Generate this week's recap" when
// it sits next to an older recap that stays put.
const generateNoun = $derived(latestDetail ? currentPeriodLabel : periodLabelLower);
const generateTitle = $derived(
  latestDetail
    ? `Write a brand-new recap for ${currentPeriodLabel} ${periodLabelLower} window. The recap below stays as-is.`
    : `Have the agent write a fresh ${periodLabelLower} recap`,
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

// A current-period generation stays put and streams into the hero above,
// matching the floating pill. A historical one has no home on this page, so
// it goes to its own.
function onCalendarGenerated(recapId: string, wasCurrentPeriod: boolean): void {
  if (!wasCurrentPeriod) void goto(`/repo/${repoId}/recaps/${recapId}`);
}

const actionsFloatStyle = $derived(getActionsFloatStyle());
</script>

<div class="period-view">
	{#if latestDetail}
		<RecapDetail
			recap={latestDetail}
			loading={detailLoading}
			{period}
			{stream}
		/>
	{:else if latest && detailLoading}
		<div class="loader-fullscreen">
			<DotMatrixLoader label="Loading {periodLabelLower} recap" />
		</div>
	{:else if listLoading && recaps.length === 0}
		<div class="loader-fullscreen">
			<DotMatrixLoader label="Loading recaps" />
		</div>
	{:else}
		<header class="period-hero">
			<span class="period-eyebrow">{periodEyebrow}</span>
			<h1 class="period-title">{periodLabel} recap</h1>
			<p class="period-lede">
				{#if period === "daily"}
					A snapshot of every pull request that opened, moved, or shipped
					today, written by the agent and ready in a minute.
				{:else}
					A week of pull-request activity distilled into one read: what
					shipped, what's still in flight, where the risk sits.
				{/if}
			</p>
		</header>
	{/if}

	<div class="aux">
		<RecapCalendar
			{repoId}
			{period}
			{recaps}
			activeRecapId={latestId}
			onGenerated={onCalendarGenerated}
		/>
	</div>
</div>

{#if showGenerateFab || genActionState}
	<div class="actions-float" style={actionsFloatStyle}>
		<div class="actions-row" role="toolbar" aria-label="Recap actions">
			{#if showGenerateFab}
				<GlassPill
					variant="accent"
					onclick={onGenerate}
					disabled={generating}
					title={generateTitle}
				>
					{#if generating}
						<Spinner size={14} class="motion-essential-spin" aria-hidden="true" />
					{:else}
						<PenNib size={16} aria-hidden="true" />
					{/if}
					<Shimmer active={!generating}>
						{generating
							? `Generating ${generateNoun} recap…`
							: `Generate ${generateNoun} recap`}
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
		width: 100%;
	}

	/* Center the loader vertically + horizontally in the available viewport
	   while the recap (or the recap list) is loading. Approximate viewport
	   height by subtracting the app shell chrome so the loader sits in the
	   visual middle of the page area, not the middle of the document. */
	.loader-fullscreen {
		display: grid;
		place-items: center;
		min-height: calc(100vh - 8rem);
		width: 100%;
	}

	/* Same centre axis and same content width as RecapDetail's reading
	   column above it — `+ 4rem` cancels this element's own padding. */
	.aux {
		max-width: calc(var(--recap-measure) + 4rem);
		margin: 0 auto;
		width: 100%;
		padding: 0 2rem 4rem;
	}

	/* Editorial empty state. Mono eyebrow → display heading → lede.
	   Sized to feel like a magazine landing, not a settings card. */
	.period-hero {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		max-width: calc(var(--recap-measure) + 4rem);
		margin: 0 auto;
		width: 100%;
		padding: 3.5rem 2rem 1.5rem;
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
		font-size: 2.5rem;
		font-weight: 500;
		letter-spacing: -0.02em;
		line-height: 1.02;
		color: var(--color-text-primary);
	}

	@media (max-width: 720px) {
		.period-title {
			font-size: 2rem;
		}
	}

	.period-lede {
		margin: 0.25rem 0 0;
		font-size: 0.9375rem;
		line-height: 1.55;
		color: var(--color-text-secondary);
		max-width: 34rem;
	}
</style>
