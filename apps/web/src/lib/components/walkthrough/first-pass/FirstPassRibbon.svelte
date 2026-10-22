<script lang="ts">
import { flaggedHunkSmells, HUNK_SMELL_META, type HunkScanRow } from "@revv/shared";
import { gsapRise, tokens } from "$lib/motion";
import { hunkRangeLabel, type ScanTick, scanTicks } from "$lib/utils/hunk-scan";

/**
 * The first pass as one strip: a tick per scanned hunk in diff order, rising
 * with Jev's strongest smell against its floor. Flagged hunks stand at full
 * height in their tone, clean ones stay low, pending ones sit on the baseline
 * until their answer lands. Past one tick per 3px, neighbouring hunks share a
 * tick showing the worst of them, so the strip keeps its size on any PR.
 * Spans only: it renders inside the stepper's `<button>`.
 */
interface Props {
  rows: readonly HunkScanRow[];
  /** Strip height in px. */
  height?: number;
}

let { rows, height = 14 }: Props = $props();

/** Narrowest tick plus the gap after it. */
const TICK_PITCH = 3;

let width = $state(0);
const ticks = $derived(scanTicks(rows, width > 0 ? (width + 1) / TICK_PITCH : 64));

function tickTitle(tick: ScanTick): string {
  const [first] = tick.hunks;
  if (!first) return "";
  const where =
    tick.hunks.length === 1
      ? `${first.filePath} ${hunkRangeLabel(first)}`
      : `${tick.hunks.length} hunks from ${first.filePath}`;
  switch (tick.state) {
    case "pending":
      return `${where}: scanning`;
    case "unscanned":
      return `${where}: not answered`;
    case "clean":
      return `${where}: nothing flagged`;
    default: {
      const smells = new Set(
        tick.hunks.flatMap((h) =>
          flaggedHunkSmells(h.signals).map((s) => HUNK_SMELL_META[s.smell].label),
        ),
      );
      return `${where}: ${[...smells].join(", ").toLowerCase()}`;
    }
  }
}
</script>

<span class="ribbon" style:--ribbon-height="{height}px" bind:clientWidth={width}>
	{#each ticks as tick, i (i)}
		<span class="tick" title={tickTitle(tick)}>
			{#key tick.state}
				<span
					class="tick-bar tick-bar--{tick.state}"
					style:--level={tick.level}
					style:--share={tick.share}
					in:gsapRise={{ duration: tokens.smooth }}
				></span>
			{/key}
		</span>
	{/each}
</span>

<style>
	.ribbon {
		display: flex;
		align-items: flex-end;
		gap: 1px;
		width: 100%;
		height: var(--ribbon-height);
		min-width: 0;
	}

	.tick {
		display: flex;
		flex: 1 1 0;
		align-items: flex-end;
		min-width: 1px;
		max-width: 6px;
		height: 100%;
	}

	.tick-bar {
		display: block;
		width: 100%;
		border-radius: 1px;
	}

	/* Waiting on Jev: a mark on the baseline, nothing risen yet. */
	.tick-bar--pending {
		height: 2px;
		background: var(--color-bg-tertiary);
	}

	/* The call failed or the budget ran out: on the baseline, but inked, so it
	   doesn't read as still coming. */
	.tick-bar--unscanned {
		height: 2px;
		background: color-mix(in srgb, var(--color-text-muted) 55%, transparent);
	}

	/* Answered and under every floor. Height is how close it came, so the
	   strip keeps the texture of the scan without crying wolf. Capped below
	   the shortest flagged tick, so tone is never the only cue. */
	.tick-bar--clean {
		height: calc(2px + var(--level) * 38%);
		background: color-mix(in srgb, var(--color-text-muted) 45%, transparent);
	}

	/* A lone lead in a shared tick rises past every clean tick; a run of
	   leads stands full height. */
	.tick-bar--warning,
	.tick-bar--danger {
		height: calc(55% + var(--share) * 45%);
		opacity: calc(0.6 + var(--share) * 0.4);
	}

	.tick-bar--warning {
		background: var(--color-warning);
	}

	.tick-bar--danger {
		background: var(--color-danger);
	}
</style>
