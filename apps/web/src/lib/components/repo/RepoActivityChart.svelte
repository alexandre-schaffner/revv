<script lang="ts">
/*
 * RepoActivityChart — a year of the repo's commits as a calendar heatmap,
 * with weekly code churn on the same week columns underneath.
 *
 * The heatmap is one sequential ramp of the repo's ink (`repoInkRamp`), so it
 * prints in the same colour as the hero engraving above it. Churn shares the
 * heatmap's x axis on purpose: a dark week in the grid and a tall bar under
 * it are the same week, no second axis to read. Additions rise in the ink,
 * deletions hang below in neutral grey; position carries the sign, the legend
 * names it.
 *
 * Bars cap at four times the year's median week rather than its maximum, so
 * one vendored-dependency week doesn't flatten the rest to slivers. A capped
 * bar is drawn full height and the tooltip carries its real value.
 */

import type { RepoActivityWeek } from "@revv/shared";

interface Props {
  /** The year to draw, oldest week first; null draws an empty placeholder grid. */
  weeks: RepoActivityWeek[] | null;
  /** The year is still on its way: sweep a skeleton highlight over the placeholder. */
  loading: boolean;
  /** Four steps of the repo's ink, faint to full. */
  ramp: string[];
}

let { weeks: data, loading, ramp }: Props = $props();

const uid = $props.id();

const CELL = 11;
const GAP = 3;
const STEP = CELL + GAP;
const GUTTER = 30;
const MONTH_ROW = 16;
const CHURN_HEIGHT = 44;
const CHURN_GAP = 12;
const BAR_WIDTH = 8;
const DAY_MS = 24 * 60 * 60 * 1000;

const DAY_LABELS = [
  { index: 1, label: "Mon" },
  { index: 3, label: "Wed" },
  { index: 5, label: "Fri" },
];

const MONTH = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" });
const DAY = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});
const WEEK = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const FULL = new Intl.NumberFormat("en-US");

/** Placeholder year while loading or on error, so the card holds its shape. */
const EMPTY_WEEKS: RepoActivityWeek[] = Array.from({ length: 52 }, (_, i) => ({
  weekStart: new Date(Date.now() - (51 - i) * 7 * DAY_MS).toISOString().slice(0, 10),
  days: [0, 0, 0, 0, 0, 0, 0],
  additions: null,
  deletions: null,
}));

const weeks = $derived(data ?? EMPTY_WEEKS);
const ready = $derived(data !== null);
const skeleton = $derived(loading && !ready);
const todayMs = Date.parse(new Date().toISOString().slice(0, 10));

interface Cell {
  key: string;
  x: number;
  y: number;
  count: number;
  date: Date;
}

const cells = $derived.by(() => {
  const out: Cell[] = [];
  weeks.forEach((week, col) => {
    const start = Date.parse(week.weekStart);
    week.days.forEach((count, row) => {
      const ms = start + row * DAY_MS;
      // GitHub reports the current week whole; the days still to come aren't zeros.
      if (ms > todayMs) return;
      out.push({
        key: `${week.weekStart}:${row}`,
        x: GUTTER + col * STEP,
        y: MONTH_ROW + row * STEP,
        count,
        date: new Date(ms),
      });
    });
  });
  return out;
});

/**
 * Quartile thresholds over the year's non-zero days, so a quiet repo and a
 * busy one both use the whole ramp. GitHub does the same on profiles.
 */
const thresholds = $derived.by(() => {
  const counts = cells
    .map((c) => c.count)
    .filter((n) => n > 0)
    .sort((a, b) => a - b);
  if (counts.length === 0) return [1, 2, 3];
  const q = (p: number) => counts[Math.min(counts.length - 1, Math.floor(p * counts.length))] ?? 1;
  return [q(0.25), q(0.5), q(0.75)];
});

function level(count: number): number {
  if (count === 0) return -1;
  const [a = 1, b = 2, c = 3] = thresholds;
  if (count <= a) return 0;
  if (count <= b) return 1;
  if (count <= c) return 2;
  return 3;
}

const months = $derived.by(() => {
  const out: { key: string; x: number; label: string }[] = [];
  let lastMonth = -1;
  let lastCol = -10;
  weeks.forEach((week, col) => {
    const d = new Date(week.weekStart);
    const month = d.getUTCMonth();
    if (month !== lastMonth) {
      lastMonth = month;
      // A label needs three columns of room or it collides with the next one.
      if (col - lastCol >= 3 && col <= weeks.length - 2) {
        out.push({ key: week.weekStart, x: GUTTER + col * STEP, label: MONTH.format(d) });
        lastCol = col;
      }
    }
  });
  return out;
});

const hasChurn = $derived(weeks.some((w) => w.additions !== null));

/*
 * A week's bar is scaled against four times the year's median non-zero week.
 * Generated code and vendored dependencies make churn heavy-tailed: scaled
 * to the maximum, one lockfile week flattens every other bar to a sliver.
 * Bars past the cap draw full height with a notch cut near the end, and the
 * tooltip keeps the real number.
 */
const churnCap = $derived.by(() => {
  const values = weeks
    .flatMap((w) => [w.additions ?? 0, w.deletions ?? 0])
    .filter((n) => n > 0)
    .sort((a, b) => a - b);
  if (values.length === 0) return 1;
  return (values[Math.floor(values.length / 2)] ?? 1) * 4;
});

const half = CHURN_HEIGHT / 2;
const barHeight = (n: number | null) =>
  n ? Math.max(2, (Math.min(n, churnCap) / churnCap) * (half - 2)) : 0;
const clipped = (n: number | null) => (n ?? 0) > churnCap;

const gridWidth = $derived(GUTTER + weeks.length * STEP - GAP);
const gridHeight = MONTH_ROW + 7 * STEP - GAP;
const churnTop = gridHeight + CHURN_GAP;
const svgHeight = $derived(hasChurn ? churnTop + CHURN_HEIGHT : gridHeight);

// ── Hover ────────────────────────────────────────────────────────────────

let tip = $state<{ key: string; x: number; y: number; title: string; detail: string } | null>(null);

const cellByPosition = $derived(new Map(cells.map((c) => [`${c.x}:${c.y}`, c])));

/**
 * One hit test for the whole plot rather than a listener per cell: map the
 * pointer into viewBox units, then to a week column and a day row (or the
 * churn strip under them). Gaps count toward the nearest cell so the tooltip
 * doesn't flicker off between squares.
 */
function onPointerMove(event: PointerEvent) {
  const svg = (event.currentTarget as HTMLElement).querySelector("svg");
  if (!svg || !ready) return;
  const box = svg.getBoundingClientRect();
  const scale = gridWidth / box.width;
  const x = (event.clientX - box.left) * scale;
  const y = (event.clientY - box.top) * scale;
  const col = Math.floor((x - GUTTER + GAP / 2) / STEP);
  const week = weeks[col];
  if (!week || x < GUTTER - GAP) {
    tip = null;
    return;
  }
  if (y >= MONTH_ROW - GAP / 2 && y < gridHeight + GAP / 2) {
    const row = Math.min(6, Math.max(0, Math.floor((y - MONTH_ROW + GAP / 2) / STEP)));
    const cell = cellByPosition.get(`${GUTTER + col * STEP}:${MONTH_ROW + row * STEP}`);
    if (cell) showCell(cell);
    else tip = null;
  } else if (hasChurn && y >= churnTop && y <= churnTop + CHURN_HEIGHT) {
    showWeek(week, col);
  } else {
    tip = null;
  }
}

function showCell(cell: Cell) {
  tip = {
    key: cell.key,
    x: cell.x + CELL / 2,
    y: cell.y,
    title: `${FULL.format(cell.count)} ${cell.count === 1 ? "commit" : "commits"}`,
    detail: DAY.format(cell.date),
  };
}

function showWeek(week: RepoActivityWeek, col: number) {
  tip = {
    key: `week:${week.weekStart}`,
    x: GUTTER + col * STEP + CELL / 2,
    y: churnTop,
    title: `+${FULL.format(week.additions ?? 0)} −${FULL.format(week.deletions ?? 0)} lines`,
    detail: `Week of ${WEEK.format(new Date(week.weekStart))}`,
  };
}

const summary = $derived.by(() => {
  if (!ready) return loading ? "Commit activity, loading" : "Commit activity unavailable";
  const commits = cells.reduce((sum, c) => sum + c.count, 0);
  const added = weeks.reduce((sum, w) => sum + (w.additions ?? 0), 0);
  const removed = weeks.reduce((sum, w) => sum + (w.deletions ?? 0), 0);
  return (
    `${FULL.format(commits)} commits in the last year` +
    (hasChurn ? `, ${FULL.format(added)} lines added and ${FULL.format(removed)} removed` : "")
  );
});
</script>

<div class="activity">

	<div
		class="plot"
		role="presentation"
		style:--plot-max-width="{gridWidth}px"
		onpointermove={onPointerMove}
		onpointerleave={() => (tip = null)}
	>
		<svg viewBox="0 0 {gridWidth} {svgHeight}" role="img" aria-label={summary} class={{ pending: !ready }}>
			{#each months as m (m.key)}
				<text class="axis" x={m.x} y={10}>{m.label}</text>
			{/each}
			{#each DAY_LABELS as d (d.index)}
				<text class="axis" x={0} y={MONTH_ROW + d.index * STEP + CELL - 2}>{d.label}</text>
			{/each}

			{#each cells as cell (cell.key)}
				{@const l = level(cell.count)}
				<rect
					class={["cell", tip?.key === cell.key && "active"]}
					x={cell.x}
					y={cell.y}
					width={CELL}
					height={CELL}
					rx="2"
					fill={l < 0 ? "var(--activity-empty)" : ramp[l]}
				/>
			{/each}

			{#if skeleton}
				<!-- One highlight crossing the whole year, clipped to the squares. The
				     band is a third of the grid so it reads at this width. -->
				<defs>
					<clipPath id="{uid}-cells">
						{#each cells as cell (cell.key)}
							<rect x={cell.x} y={cell.y} width={CELL} height={CELL} rx="2" />
						{/each}
					</clipPath>
					<linearGradient id="{uid}-sweep">
						<stop class="sweep-edge" offset="0.35" />
						<stop class="sweep-peak" offset="0.5" />
						<stop class="sweep-edge" offset="0.65" />
					</linearGradient>
				</defs>
				<g clip-path="url(#{uid}-cells)">
					<rect
						class="sweep"
						x={GUTTER}
						y={MONTH_ROW}
						width={gridWidth - GUTTER}
						height={gridHeight - MONTH_ROW}
						fill="url(#{uid}-sweep)"
					/>
				</g>
			{/if}

			{#if hasChurn}
				<line class="baseline" x1={GUTTER} x2={gridWidth} y1={churnTop + half} y2={churnTop + half} />
				{#each weeks as week, col (week.weekStart)}
					{@const cx = GUTTER + col * STEP + (CELL - BAR_WIDTH) / 2}
					{@const up = barHeight(week.additions)}
					{@const down = barHeight(week.deletions)}
					{#if up > 0}
						<rect class="bar" x={cx} y={churnTop + half - 1 - up} width={BAR_WIDTH} height={up} rx="1.5" fill={ramp[2]} />
						{#if clipped(week.additions)}
							<rect class="notch" x={cx - 0.5} y={churnTop + 3} width={BAR_WIDTH + 1} height="1.5" />
						{/if}
					{/if}
					{#if down > 0}
						<rect class="bar removed" x={cx} y={churnTop + half + 1} width={BAR_WIDTH} height={down} rx="1.5" />
						{#if clipped(week.deletions)}
							<rect class="notch" x={cx - 0.5} y={churnTop + CHURN_HEIGHT - 4.5} width={BAR_WIDTH + 1} height="1.5" />
						{/if}
					{/if}
				{/each}
			{/if}
		</svg>

		{#if tip}
			<div
				class="tip"
				style:left="{(tip.x / gridWidth) * 100}%"
				style:top="{(tip.y / svgHeight) * 100}%"
			>
				<strong>{tip.title}</strong>
				<span>{tip.detail}</span>
			</div>
		{/if}
	</div>

	<footer class="legend">
		{#if hasChurn}
			<span class="key"><i class="swatch" style:background={ramp[2]}></i>Lines added</span>
			<span class="key"><i class="swatch removed"></i>Lines removed</span>
		{/if}
		<span class="scale">
			Less
			<i class="swatch" style:background="var(--activity-empty)"></i>
			{#each ramp as colour (colour)}
				<i class="swatch" style:background={colour}></i>
			{/each}
			More
		</span>
	</footer>
</div>

<style>
	.activity {
		--activity-empty: var(--color-bg-tertiary);
		display: flex;
		flex-direction: column;
		gap: 12px;
	}







	.plot {
		position: relative;
		max-width: var(--plot-max-width);
	}

	svg {
		display: block;
		width: 100%;
		height: auto;
		overflow: visible;
	}

	svg.pending .cell {
		fill: var(--activity-empty);
	}

	/* The shared `.skeleton` sweep (app.css), drawn in SVG. */
	.sweep {
		transform-box: fill-box;
		transform: translateX(-100%);
		animation: skeleton-sweep var(--duration-pulse) var(--ease-soft) infinite;
	}

	.sweep-edge {
		stop-color: var(--color-text-primary);
		stop-opacity: 0;
	}

	.sweep-peak {
		stop-color: var(--color-text-primary);
		stop-opacity: 0.08;
	}

	.axis {
		font-size: 9px;
		fill: var(--color-text-muted);
	}

	.cell.active {
		stroke: var(--color-text-primary);
		stroke-width: 1;
	}

	.baseline {
		stroke: var(--color-border-subtle);
		stroke-width: 1;
	}

	/* The surface showing through: "this bar runs off the scale". */
	.notch {
		fill: var(--color-bg-primary);
	}

	.bar.removed {
		fill: var(--color-text-muted);
		opacity: 0.55;
	}

	.tip {
		position: absolute;
		transform: translate(-50%, calc(-100% - 8px));
		display: flex;
		flex-direction: column;
		gap: 1px;
		padding: 5px 8px;
		border-radius: 6px;
		background: var(--color-bg-elevated);
		border: 1px solid var(--color-border);
		box-shadow: 0 4px 12px rgb(0 0 0 / 0.08);
		font-size: 11px;
		white-space: nowrap;
		pointer-events: none;
		z-index: 2;
	}

	.tip strong {
		font-weight: 600;
		color: var(--color-text-primary);
	}

	.tip span {
		color: var(--color-text-muted);
	}

	.legend {
		display: flex;
		align-items: center;
		gap: 14px;
		font-size: 11px;
		color: var(--color-text-muted);
	}

	.key,
	.scale {
		display: inline-flex;
		align-items: center;
		gap: 5px;
	}

	.scale {
		margin-left: auto;
		gap: 3px;
	}

	.swatch {
		display: inline-block;
		width: 10px;
		height: 10px;
		border-radius: 2px;
	}

	.swatch.removed {
		background: var(--color-text-muted);
		opacity: 0.55;
	}
</style>
