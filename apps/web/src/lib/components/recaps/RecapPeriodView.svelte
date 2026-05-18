<script lang="ts">
import { Loader2, Sparkles } from "@lucide/svelte";
import type { ProjectRecap, ProjectRecapSummary, RecapPeriod } from "@revv/shared";
import { untrack } from "svelte";
import { Shimmer } from "$lib/components/ai/shimmer";
import { RAIL_WIDTH } from "$lib/constants";
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
import PreviousRecaps from "./PreviousRecaps.svelte";
import RecapDetail from "./RecapDetail.svelte";

interface Props {
  repoId: string;
  period: RecapPeriod;
}

let { repoId, period }: Props = $props();

let generating = $state(false);
let regenerating = $state(false);

const periodLabel = $derived(period === "daily" ? "Daily" : "Weekly");
const periodLabelLower = $derived(period === "daily" ? "daily" : "weekly");

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

// Mirror AppShell.floatingActionsStyle exactly so the recap pill is centred
// over the visible main area between the sidebar and (optional) right panel
// rather than the full viewport.
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

// Show the floating Generate pill on the empty/loading states. Once a
// recap is in view, RecapDetail owns its own Regenerate pill, so we
// stand down to avoid stacking two bars.
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
  if (!id || regenerating) return;
  regenerating = true;
  try {
    resetRecapStream(id);
    await regenerateRecap(id);
  } finally {
    regenerating = false;
  }
}
</script>

<div class="period-view">
	{#if latestDetail}
		<RecapDetail
			recap={latestDetail}
			loading={detailLoading}
			{onRegenerate}
			{regenerating}
			{stream}
			{floatingActionsStyle}
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

{#if showGenerateFab}
	<div class="recap-actions-float" style={floatingActionsStyle}>
		<div class="recap-actions-row">
			<button
				type="button"
				class="recap-action-btn recap-action-btn--accent"
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
			</button>
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
		padding: 1rem 1.25rem 7rem;
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

	/* Floating action pill — mirrors `.walkthrough-actions-float` in
	   AppShell so the recap CTA reads as a member of the same family
	   as the walkthrough / request-changes bars. Fixed (not absolute)
	   because this component renders inside `.main-area`, which has
	   `overflow: hidden` and no positioning context of its own. The
	   inline `left/right` derived from sidebar + right-panel state
	   centres the pill over the visible main column, same as the
	   walkthrough/RC bars upstairs. */
	.recap-actions-float {
		position: fixed;
		bottom: 40px;
		display: flex;
		justify-content: center;
		z-index: 20;
		pointer-events: none;
		padding-bottom: 12px;
		transition:
			left var(--duration-smooth) var(--ease-out-expo),
			right var(--duration-instant) var(--ease-out-expo);
	}

	.recap-actions-float :global(*) {
		pointer-events: auto;
	}

	.recap-actions-row {
		display: inline-flex;
		align-items: center;
		gap: 8px;
	}

	/* Glass pill — same recipe as `.walkthrough-action-btn`. */
	.recap-action-btn {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		height: 36px;
		padding: 0 16px;
		background: var(--color-tab-track-bg);
		backdrop-filter: blur(16px) saturate(1.4);
		-webkit-backdrop-filter: blur(16px) saturate(1.4);
		border: 1px solid var(--color-glass-border);
		border-radius: 9999px;
		box-shadow:
			var(--color-glass-shadow),
			inset 0 0.5px 0 0 var(--color-glass-highlight);
		font-family: inherit;
		font-size: 13px;
		font-weight: 500;
		letter-spacing: -0.01em;
		line-height: 1;
		color: var(--color-text-primary);
		cursor: pointer;
		transition:
			background-color var(--duration-snap),
			color var(--duration-snap),
			box-shadow var(--duration-snap);
		-webkit-font-smoothing: antialiased;
		white-space: nowrap;
	}

	.recap-action-btn:hover {
		background: color-mix(
			in srgb,
			var(--color-tab-active-bg) 80%,
			var(--color-tab-track-bg)
		);
	}

	.recap-action-btn:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: 2px;
	}

	.recap-action-btn--accent:not(:disabled) {
		color: var(--color-accent);
	}

	.recap-action-btn:disabled {
		cursor: not-allowed;
		opacity: 0.55;
	}
</style>
