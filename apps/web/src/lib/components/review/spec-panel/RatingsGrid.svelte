<script lang="ts">
import type { RatingAxis, Verdict, WalkthroughBlock, WalkthroughRating } from "@revv/shared";
import { RATING_AXES, RATING_AXIS_LABELS } from "@revv/shared";
import Check from "phosphor-svelte/lib/Check";
import Spinner from "phosphor-svelte/lib/Spinner";
import Star from "phosphor-svelte/lib/Star";
import Warning from "phosphor-svelte/lib/Warning";
import XCircle from "phosphor-svelte/lib/XCircle";
import { SvelteMap } from "svelte/reactivity";
import { formatDuration } from "./format-duration";
import RatingCell, { type CellState } from "./RatingCell.svelte";
import RatingsFooter from "./RatingsFooter.svelte";
import SpecCount from "./SpecCount.svelte";
import SpecSummaryBar from "./SpecSummaryBar.svelte";

interface Props {
  ratings: WalkthroughRating[];
  blocks: WalkthroughBlock[];
  onJump: (blockId: string) => void;
  /**
   * Render even with zero ratings, so live generation shows the queued grid
   * from the start. Off by default so a stored pre-scorecard walkthrough
   * doesn't render nine empty queued cells.
   */
  forceShow?: boolean;
}

let { ratings, blocks, onJump, forceShow = false }: Props = $props();

const visible = $derived(ratings.length > 0 || forceShow);

const ratingByAxis = $derived.by(() => {
  const map = new Map<RatingAxis, WalkthroughRating>();
  for (const r of ratings) map.set(r.axis, r);
  return map;
});

const tally = $derived.by(() => {
  let pass = 0;
  let concern = 0;
  let blocker = 0;
  for (const r of ratings) {
    if (r.verdict === "pass") pass++;
    else if (r.verdict === "concern") concern++;
    else blocker++;
  }
  return {
    pass,
    concern,
    blocker,
    total: ratings.length,
    pending: RATING_AXES.length - ratings.length,
  };
});

const allPassed = $derived(
  tally.total === RATING_AXES.length && tally.concern === 0 && tally.blocker === 0,
);

// The server doesn't announce "started axis X", so this approximates it:
// axes resolve in RATING_AXES order, and the first unrated axis after a
// rated one reads as running. Before any rating arrives the agent is still
// in an earlier phase, so every cell stays queued.
function cellState(axis: RatingAxis, index: number): CellState {
  if (ratingByAxis.has(axis)) return "resolved";
  if (ratings.length === 0) return "queued";
  if (index === 0) return "running";
  const prevAxis = RATING_AXES[index - 1];
  if (prevAxis && ratingByAxis.has(prevAxis)) return "running";
  return "queued";
}

// Ratings carry no timestamp, so elapsed time is measured from when each
// one reached this component.
const mountTime = Date.now();
const arrivals = new SvelteMap<RatingAxis, number>();
let firstArrivalTime = $state<number | null>(null);

$effect(() => {
  const now = Date.now();
  if (ratings.length > 0 && firstArrivalTime === null) {
    firstArrivalTime = now;
  }
  for (const r of ratings) {
    if (!arrivals.has(r.axis)) arrivals.set(r.axis, now);
  }
});

// All nine within 200ms of mount is a stored walkthrough loading, not a
// live run; its elapsed would read a meaningless "0ms".
const isCachedReplay = $derived(
  ratings.length === RATING_AXES.length &&
    firstArrivalTime !== null &&
    firstArrivalTime - mountTime < 200,
);

/** First arrival to last; null until all nine have landed so it doesn't jitter mid-stream. */
const totalElapsedMs = $derived.by(() => {
  if (ratings.length < RATING_AXES.length) return null;
  if (firstArrivalTime === null) return null;
  if (isCachedReplay) return null;
  let latest = firstArrivalTime;
  for (const axis of RATING_AXES) {
    const t = arrivals.get(axis);
    if (t !== undefined && t > latest) latest = t;
  }
  return latest - firstArrivalTime;
});

const runningCount = $derived.by(() => {
  let n = 0;
  for (let i = 0; i < RATING_AXES.length; i++) {
    const axis = RATING_AXES[i];
    if (!axis) continue;
    if (cellState(axis, i) === "running") n++;
  }
  return n;
});

// "Only failing" dims passing cells instead of removing them, so the 3×3
// map the reader has learned keeps its shape.
let onlyFailing = $state(false);

// A burst of ratings in one tick (a cached replay) leaves only the last
// message in the live region, which throttles it for free.
let srMessage = $state("");
const announcedAxes = new Set<RatingAxis>();

const verdictSpoken: Record<Verdict, string> = {
  pass: "passed",
  concern: "raised a concern",
  blocker: "flagged a blocker",
};

$effect(() => {
  for (const r of ratings) {
    if (announcedAxes.has(r.axis)) continue;
    announcedAxes.add(r.axis);
    srMessage = `${RATING_AXIS_LABELS[r.axis]} ${verdictSpoken[r.verdict]} with ${r.confidence} confidence`;
  }
});

const cellRefs: Record<RatingAxis, HTMLElement | null> = {
  correctness: null,
  scope: null,
  tests: null,
  clarity: null,
  safety: null,
  consistency: null,
  api_changes: null,
  performance: null,
  description: null,
};

// Must match the CSS grid's `repeat(3, ...)`. Narrow widths reflow the grid
// visually, but arrows keep walking the 3-column order.
const GRID_COLS = 3;

function onGridKeydown(e: KeyboardEvent): void {
  const target = e.target as HTMLElement | null;
  const targetAxis = RATING_AXES.find((a) => cellRefs[a] === target);
  if (targetAxis === undefined) return;

  const idx = RATING_AXES.indexOf(targetAxis);
  const row = Math.floor(idx / GRID_COLS);
  const col = idx % GRID_COLS;
  const lastRow = Math.floor((RATING_AXES.length - 1) / GRID_COLS);

  let nextIdx: number | null = null;

  if (e.key === "ArrowRight") {
    const maxColThisRow = Math.min(GRID_COLS - 1, RATING_AXES.length - 1 - row * GRID_COLS);
    if (col < maxColThisRow) nextIdx = idx + 1;
  } else if (e.key === "ArrowLeft") {
    if (col > 0) nextIdx = idx - 1;
  } else if (e.key === "ArrowDown") {
    if (row < lastRow) nextIdx = Math.min(idx + GRID_COLS, RATING_AXES.length - 1);
  } else if (e.key === "ArrowUp") {
    if (row > 0) nextIdx = idx - GRID_COLS;
  } else if (e.key === "Home") {
    nextIdx = 0;
  } else if (e.key === "End") {
    nextIdx = RATING_AXES.length - 1;
  } else {
    return;
  }

  if (nextIdx === null) return;
  e.preventDefault();
  const next = RATING_AXES[nextIdx];
  if (next) cellRefs[next]?.focus();
}
</script>

{#if visible}
    <!-- Keys bubble up from the cell triggers; the section itself stays non-interactive. -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <section
        class="ratings-grid-panel"
        aria-label="PR quality checks"
        onkeydown={onGridKeydown}
        role="group"
    >
        <div class="sr-only" aria-live="polite" aria-atomic="false">
            {srMessage}
        </div>

        <SpecSummaryBar
            title="Scores"
            filters={[
                {
                    label: "Only failing",
                    active: onlyFailing,
                    onToggle: () => (onlyFailing = !onlyFailing),
                    tone: "concern",
                },
            ]}
        >
            {#snippet icon()}<Star size={14} weight="fill" />{/snippet}
            {#snippet counts()}
                <SpecCount tone="pass" count={tally.pass} label="passed">
                    <Check size={11} />
                </SpecCount>
                <SpecCount
                    tone="concern"
                    count={tally.concern}
                    label={tally.concern === 1 ? "concern" : "concerns"}
                >
                    <Warning size={11} weight="fill" />
                </SpecCount>
                <SpecCount
                    tone="blocker"
                    count={tally.blocker}
                    label={tally.blocker === 1 ? "blocker" : "blockers"}
                >
                    <XCircle size={11} weight="fill" />
                </SpecCount>
                {#if runningCount > 0}
                    <SpecCount tone="running" label="{runningCount} running">
                        <Spinner size={11} class="motion-essential-spin" />
                    </SpecCount>
                {/if}
                {#if totalElapsedMs !== null}
                    <span class="count-elapsed" title="Total elapsed">
                        · {formatDuration(totalElapsedMs)}
                    </span>
                {/if}
            {/snippet}
        </SpecSummaryBar>

        <div
            class="rating-grid"
            class:rating-grid--only-failing={onlyFailing}
            role="list"
        >
            {#each RATING_AXES as axis, i (axis)}
                <div class="rating-grid-item" role="listitem">
                    <RatingCell
                        {axis}
                        rating={ratingByAxis.get(axis) ?? null}
                        state={cellState(axis, i)}
                        {blocks}
                        {onJump}
                        bind:triggerRef={cellRefs[axis]}
                    />
                </div>
            {/each}
        </div>

        <RatingsFooter counts={tally} {totalElapsedMs} {allPassed} />
    </section>
{/if}

<style>
    .ratings-grid-panel {
        --grid-line: color-mix(
            in srgb,
            var(--color-border) 60%,
            transparent
        );

        display: flex;
        flex-direction: column;
        background: var(--color-bg-secondary);
        border: 1px solid var(--color-border);
        border-radius: 10px;
        overflow: hidden;
        font-family: var(--font-mono);
        /* Not `spec-panel`: the grid reflows on its own breakpoints and keeps
           its labels when narrow. */
        container-type: inline-size;
        container-name: ratings-grid;
    }

    .count-elapsed {
        font-family: var(--font-mono);
        font-size: 11.5px;
        color: var(--color-text-muted);
        font-variant-numeric: tabular-nums;
    }

    .sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
        border: 0;
    }

    .rating-grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 1px;
        background: var(--grid-line);
    }

    .rating-grid :global(.cell) {
        /* The 1px gap over the hairline background draws the separators;
           per-cell borders would double up at adjacencies. */
        width: 100%;
        height: 100%;
    }

    /* Pass cells stay clickable, to read why they passed. */
    .rating-grid--only-failing :global(.cell--pass) {
        opacity: 0.3;
    }

    @container ratings-grid (max-width: 680px) {
        .rating-grid {
            grid-template-columns: repeat(2, minmax(0, 1fr));
        }
    }

    @container ratings-grid (max-width: 440px) {
        .rating-grid {
            grid-template-columns: 1fr;
        }
    }
</style>
