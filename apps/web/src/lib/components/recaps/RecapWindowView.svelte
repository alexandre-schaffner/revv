<script lang="ts">
import type { RecapPeriod } from "@revv/shared";
import ArrowLeft from "phosphor-svelte/lib/ArrowLeft";
import PenNib from "phosphor-svelte/lib/PenNib";
import Spinner from "phosphor-svelte/lib/Spinner";
import { untrack } from "svelte";
import { goto } from "$app/navigation";
import { Shimmer } from "$lib/components/ai/shimmer";
import { Button } from "$lib/components/ui/button";
import GlassPill from "$lib/components/ui/glass-pill/GlassPill.svelte";
import { fetchRecapsForRepo, generateRecap, getRecapsForRepo } from "$lib/stores/recaps.svelte";
import { getActionsFloatStyle } from "$lib/stores/sidebar.svelte";
import {
  addUtcDays,
  dayKeyToUtcDate,
  isCurrentPeriod,
  mondayKeyOf,
  recapSlotKey,
  selectionBoundaries,
  slotKeyFor,
} from "./period-window";
import RecapArchivePopover from "./RecapArchivePopover.svelte";

/**
 * A recap window that holds nothing yet.
 *
 * Every cell in the archive calendar is a link, which means the empty ones
 * need somewhere to land. This is that page: it names the window, says there
 * is no recap for it, and offers to write one. As soon as a recap exists for
 * the window — because this page generated it, or because the scheduler did —
 * it hands off to that recap's permalink.
 */
interface Props {
  repoId: string;
  period: RecapPeriod;
  /** Any day inside the window; weekly snaps to its Monday. */
  dayKey: string;
}

let { repoId, period, dayKey }: Props = $props();

let generating = $state(false);

$effect(() => {
  const id = repoId;
  if (id) void untrack(() => fetchRecapsForRepo(id));
});

const recaps = $derived(getRecapsForRepo(repoId));
const slotKey = $derived(slotKeyFor(period, dayKey));

/** The recap occupying this window, if one has appeared. */
const existing = $derived(
  recaps.find((r) => r.status !== "superseded" && recapSlotKey(r) === slotKey) ?? null,
);

// Hand off the moment the window stops being empty. `replaceState` rather than
// a push: this page was a placeholder for a recap that now exists, and leaving
// it in history means Back bounces the user straight off the recap again.
$effect(() => {
  const r = existing;
  if (!r) return;
  void untrack(() => goto(`/repo/${repoId}/recaps/${r.id}`, { replaceState: true }));
});

const DAY_MONTH_YEAR = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "2-digit",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
const DAY_MONTH = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  timeZone: "UTC",
});

// Same titles RecapHeroBig builds for a real recap, so arriving here and then
// generating does not restyle the heading under the user.
const title = $derived.by(() => {
  if (period === "daily") return DAY_MONTH_YEAR.format(dayKeyToUtcDate(dayKey));
  const monday = mondayKeyOf(dayKey);
  const sunday = addUtcDays(monday, 6);
  return `Week of ${DAY_MONTH.format(dayKeyToUtcDate(monday))} – ${DAY_MONTH.format(dayKeyToUtcDate(sunday))}`;
});

const unit = $derived(period === "daily" ? "day" : "week");

/**
 * The window is still accumulating, so a recap generated now covers part of
 * it. That is the one thing worth saying under the date here — on a closed
 * window there is nothing, and the bare "UTC" that used to sit there was a
 * dangling word (on a real recap the same line reads "UTC · synced 10h ago").
 */
const windowStillOpen = $derived(isCurrentPeriod(period, dayKey, new Date()));
const actionsFloatStyle = $derived(getActionsFloatStyle());

async function onGenerate(): Promise<void> {
  if (generating) return;
  generating = true;
  try {
    // A closed window goes out pinned and idempotent; a live one omits its
    // boundaries so the server rolls its own [00:00Z, now]. Passing
    // `undefined` rather than `{}` is load-bearing under
    // `exactOptionalPropertyTypes` — see `selectionBoundaries`.
    const boundaries = selectionBoundaries(period, dayKey, new Date());
    const res = await generateRecap(repoId, period, boundaries ?? undefined);
    if (res?.recapId) void goto(`/repo/${repoId}/recaps/${res.recapId}`);
  } finally {
    generating = false;
  }
}
</script>

<div class="window-route">
	<div class="page">
		<div class="window-page">
			<div class="back-row">
				<Button variant="ghost" size="sm" onclick={() => goto(`/repo/${repoId}/recaps`)}>
					<ArrowLeft />
					Back
				</Button>
			</div>

			<header class="hero">
				<span class="eyebrow">
					<span class="ai-mark" aria-hidden="true"></span>
					<span>{period === "daily" ? "Daily recap" : "Weekly recap"}</span>
				</span>
				<div class="date-row">
					<h1 class="date">{title}</h1>
					<RecapArchivePopover {repoId} {period} {recaps} initialDayKey={dayKey} />
				</div>
				{#if windowStillOpen}
					<span class="time-cap">Still open · 00:00 UTC → now</span>
				{/if}
			</header>

			<div class="empty-card">
				<p class="empty-title">No recap for this {unit} yet.</p>
				<p class="empty-hint">
					The agent reads every pull request that moved in the window and writes it
					up. Takes about a minute.
				</p>
			</div>
		</div>
	</div>

	<div class="actions-float" style={actionsFloatStyle}>
		<div class="actions-row" role="toolbar" aria-label="Recap actions">
			<GlassPill
				variant="accent"
				onclick={onGenerate}
				disabled={generating}
				title="Write the {period} recap for {title}"
			>
				{#if generating}
					<Spinner size={14} class="motion-essential-spin" aria-hidden="true" />
				{:else}
					<PenNib size={16} aria-hidden="true" />
				{/if}
				<Shimmer active={!generating}>
					{generating ? "Generating recap…" : "Generate recap"}
				</Shimmer>
			</GlassPill>
		</div>
	</div>
</div>

<style>
	/* Mirrors the recap route's wrapper: the fixed action bar must not be a
	   descendant of the scroll container. */
	.window-route {
		position: relative;
		height: 100%;
		overflow: hidden;
	}

	.page {
		height: 100%;
		overflow-y: auto;
	}

	/* Same measure and gutters as `.recap-page`, so generating from here does
	   not shift the column the user is looking at. */
	.window-page {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		width: 100%;
		max-width: calc(var(--recap-measure) + 4rem);
		margin: 0 auto;
		padding: 1.5rem 2rem 4.5rem;
	}

	.back-row {
		align-self: flex-start;
	}

	.hero {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		padding-bottom: 1.5rem;
	}

	.eyebrow {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		font-weight: 500;
		text-transform: uppercase;
		letter-spacing: 0.18em;
		color: var(--color-text-muted);
	}

	.ai-mark {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--color-ai-accent);
		flex-shrink: 0;
	}

	.date-row {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.25rem 1.5rem;
		min-width: 0;
	}

	.date-row :global(.archive-trigger) {
		margin-left: auto;
		flex-shrink: 0;
	}

	.date {
		margin: 0;
		font-family: "Newsreader", Georgia, serif;
		font-size: 2.75rem;
		font-weight: 500;
		letter-spacing: -0.02em;
		line-height: 1.05;
		color: var(--color-text-primary);
		text-wrap: balance;
	}

	.time-cap {
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		letter-spacing: 0.04em;
		color: var(--color-text-muted);
	}

	.empty-card {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		align-items: center;
		text-align: center;
		padding: 3rem 2rem;
		border: 1px dashed color-mix(in srgb, var(--color-text-muted) 30%, transparent);
		border-radius: 0.75rem;
	}

	.empty-title {
		margin: 0;
		font-size: 1rem;
		font-weight: 500;
		color: var(--color-text-primary);
	}

	.empty-hint {
		margin: 0;
		max-width: 28rem;
		font-size: 0.875rem;
		line-height: 1.55;
		color: var(--color-text-subtle);
		text-wrap: pretty;
	}
</style>
