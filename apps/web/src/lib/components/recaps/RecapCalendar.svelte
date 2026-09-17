<script lang="ts">
import type { ProjectRecapSummary, RecapPeriod } from "@revv/shared";
import CalendarDots from "phosphor-svelte/lib/CalendarDots";
import CaretLeft from "phosphor-svelte/lib/CaretLeft";
import CaretRight from "phosphor-svelte/lib/CaretRight";
import PenNib from "phosphor-svelte/lib/PenNib";
import Spinner from "phosphor-svelte/lib/Spinner";
import WarningCircle from "phosphor-svelte/lib/WarningCircle";
import { untrack } from "svelte";
import { goto } from "$app/navigation";
import { Badge } from "$lib/components/ui/badge";
import { gsapFade, gsapPress } from "$lib/motion";
import {
  fetchRecapsForMonth,
  generateRecap,
  getMonthRecapsLoading,
  regenerateRecap,
} from "$lib/stores/recaps.svelte";
import {
  addUtcDays,
  dayKeyToUtcDate,
  formatSlot,
  isCurrentPeriod,
  mondayKeyOf,
  monthGrid,
  monthKeyOf,
  recapSlotKey,
  selectionBoundaries,
  shiftMonth,
  slotKeyFor,
  utcDateKey,
  utcDayKey,
} from "./period-window";
import RecapStats from "./RecapStats.svelte";

/**
 * Month calendar over a repo's recaps. Every cell — filled or empty — is a
 * generation target, which is the point: the old flat archive list could only
 * show what already existed, so gaps in history were invisible and unfillable.
 *
 * Everything here is UTC, always. A user at UTC+13 sees local 4 June while UTC
 * is still 3 June; if the today-ring followed local time they'd click what
 * looks like yesterday, hit the idempotent past-window path, and watch nothing
 * happen. Hence the `· UTC` marker in the footer, matching the eyebrow on the
 * recap hero above.
 */
interface Props {
  repoId: string;
  period: RecapPeriod;
  /** All recaps for the repo (any period). The component filters internally. */
  recaps: ProjectRecapSummary[];
  /** The recap rendered above this calendar, highlighted in the grid. */
  activeRecapId?: string | null;
  /** Month/day the calendar opens on. Defaults to the active recap, else UTC today. */
  initialDayKey?: string;
  /**
   * Fired after a generation is accepted. `wasCurrentPeriod` distinguishes a
   * rolling today/this-week run (which the caller may want to keep on-page and
   * stream) from a historical one (which lives on its own page).
   */
  onGenerated?: (recapId: string, wasCurrentPeriod: boolean) => void;
}

let { repoId, period, recaps, activeRecapId = null, initialDayKey, onGenerated }: Props = $props();

/** Pre-Step-2b rows carry this message for a window that simply held nothing. */
const LEGACY_EMPTY_WINDOW_MESSAGE = "No archived or open PRs found for this window";

// ── Clock ───────────────────────────────────────────────────────────────────

// A page left open across UTC midnight must re-paint the today ring, so the
// current day key is state on a slow tick rather than a one-shot constant.
let nowKey = $state(utcDateKey(new Date()));

$effect(() => {
  const id = setInterval(() => {
    const next = utcDateKey(new Date());
    if (next !== nowKey) nowKey = next;
  }, 60_000);
  return () => clearInterval(id);
});

const currentMonth = $derived(monthKeyOf(nowKey));

// ── View state ──────────────────────────────────────────────────────────────

const activeRecap = $derived(recaps.find((r) => r.id === activeRecapId) ?? null);

/**
 * Day the calendar opens on: the caller's anchor, else the recap rendered
 * above, else UTC today. Read through `untrack` so the initial state below
 * snapshots it rather than subscribing to it.
 */
const initialAnchor = untrack(
  () => initialDayKey ?? (activeRecap ? utcDayKey(activeRecap.periodStart) : nowKey),
);

let viewMonth = $state(monthKeyOf(initialAnchor));
let selectedDayKey = $state<string | null>(null);
let focusedDayKey = $state(initialAnchor);
let hoverWeekKey = $state<string | null>(null);
let generating = $state(false);
// Mouse selection must not yank focus out from under the pointer; only
// keyboard navigation moves the DOM focus ring.
let shouldStealFocus = $state(false);

// Re-anchor only when the caller explicitly re-points us — navigating between
// recap pages changes `initialDayKey`, and the calendar should follow to that
// recap's month. Deliberately *not* keyed off `activeRecap`: on the period
// view the active recap changes whenever a new one finishes, which would yank
// a user who had paged back to March straight into the current month.
let lastAnchor = initialAnchor;
$effect(() => {
  const key = initialDayKey;
  if (key === undefined || key === lastAnchor) return;
  lastAnchor = key;
  untrack(() => {
    viewMonth = monthKeyOf(key);
    focusedDayKey = key;
  });
});

const grid = $derived(monthGrid(viewMonth));
const weekdayLabels = $derived(
  (grid.weeks[0] ?? []).map((k) => WEEKDAY_FMT.format(dayKeyToUtcDate(k))),
);

// ── Slot index ──────────────────────────────────────────────────────────────

/**
 * `slotKey → recap`, holding daily *and* weekly rows at once so toggling the
 * period costs nothing and triggers no refetch. Superseded rows are skipped —
 * the server excludes them but the merged store cache keeps them around — and
 * when two rows share a slot the newest generation wins.
 */
const slotIndex = $derived.by(() => {
  const map = new Map<string, ProjectRecapSummary>();
  for (const r of recaps) {
    if (r.status === "superseded") continue;
    const key = recapSlotKey(r);
    const existing = map.get(key);
    if (!existing || r.generatedAt > existing.generatedAt) map.set(key, r);
  }
  return map;
});

type SlotKind = "complete" | "generating" | "error" | "quiet" | "empty";

function recapKind(r: ProjectRecapSummary | undefined, dayKey: string): SlotKind {
  if (!r) return "empty";
  if (r.status === "generating") return "generating";
  if (r.status === "error") {
    // Shim for rows written before quiet historical windows completed
    // normally. They're failures on paper only; painting them destructive
    // would light up every quiet weekend in the archive.
    const quiet =
      r.errorMessage === LEGACY_EMPTY_WINDOW_MESSAGE &&
      !isCurrentPeriod(period, dayKey, dayKeyToUtcDate(nowKey));
    return quiet ? "quiet" : "error";
  }
  return "complete";
}

/** Recap occupying this cell's slot, whatever the current period mode. */
function recapAt(dayKey: string): ProjectRecapSummary | undefined {
  return slotIndex.get(slotKeyFor(period, dayKey));
}

/**
 * Whether the slot anchored here has already closed in the future sense —
 * daily compares the day itself; weekly compares Mondays, so the current week
 * stays selectable even though its later cells render as future days.
 */
function slotIsFuture(dayKey: string): boolean {
  return period === "daily" ? dayKey > nowKey : mondayKeyOf(dayKey) > mondayKeyOf(nowKey);
}

function isToday(dayKey: string): boolean {
  return dayKey === nowKey;
}

function dayNumber(dayKey: string): string {
  return String(Number(dayKey.slice(8, 10)));
}

const WEEKDAY_FMT = new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: "UTC" });
const MONTH_FMT = new Intl.DateTimeFormat("en-GB", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

const monthLabel = $derived(MONTH_FMT.format(dayKeyToUtcDate(`${viewMonth}-01`)));
const canGoNext = $derived(viewMonth < currentMonth);

function cellLabel(dayKey: string): string {
  const r = recapAt(dayKey);
  const kind = recapKind(r, dayKey);
  const state =
    kind === "complete"
      ? "complete"
      : kind === "generating"
        ? "generating"
        : kind === "error"
          ? "failed"
          : kind === "quiet"
            ? "no activity"
            : slotIsFuture(dayKey)
              ? "in the future"
              : "not generated";
  return `${formatSlot(period, dayKey)} — ${period} recap, ${state}`;
}

// ── Month prefetch ──────────────────────────────────────────────────────────

// One fetch for the month on screen, one warming the month before it: users
// page backwards through history, and forwards is capped at today.
$effect(() => {
  const month = viewMonth;
  const id = repoId;
  if (id) void untrack(() => fetchRecapsForMonth(id, month));
});

$effect(() => {
  const month = shiftMonth(viewMonth, -1);
  const id = repoId;
  if (id) void untrack(() => fetchRecapsForMonth(id, month));
});

// The geometry is known before the data lands, so the grid never collapses to
// a loader — empty cells render skeleton dots in place. Keyed off the in-flight
// flag rather than "not yet loaded", which would strand the dots forever on a
// month whose fetch failed.
const monthPending = $derived(getMonthRecapsLoading(repoId, viewMonth));

// ── Navigation ──────────────────────────────────────────────────────────────

function goToMonth(monthKey: string): void {
  if (monthKey > currentMonth) return;
  viewMonth = monthKey;
}

function stepMonth(delta: number): void {
  goToMonth(shiftMonth(viewMonth, delta));
}

function jumpToToday(): void {
  viewMonth = currentMonth;
  focusedDayKey = nowKey;
  shouldStealFocus = true;
  select(nowKey);
}

function select(dayKey: string): void {
  selectedDayKey = dayKey;
  focusedDayKey = dayKey;
  // Clicking a leading/trailing day is a request to see that month.
  if (monthKeyOf(dayKey) !== viewMonth) goToMonth(monthKeyOf(dayKey));
}

function onCellClick(dayKey: string): void {
  if (slotIsFuture(dayKey)) return;
  shouldStealFocus = false;
  select(dayKey);
}

function moveFocus(dayKey: string): void {
  focusedDayKey = dayKey;
  shouldStealFocus = true;
  if (monthKeyOf(dayKey) !== viewMonth) {
    // Auto-advance the view rather than focusing a cell the user can't see.
    const target = monthKeyOf(dayKey);
    if (target <= currentMonth) viewMonth = target;
  }
}

function onGridKeydown(e: KeyboardEvent): void {
  const key = focusedDayKey;
  switch (e.key) {
    case "ArrowLeft":
      moveFocus(addUtcDays(key, -1));
      break;
    case "ArrowRight":
      moveFocus(addUtcDays(key, 1));
      break;
    case "ArrowUp":
      moveFocus(addUtcDays(key, -7));
      break;
    case "ArrowDown":
      moveFocus(addUtcDays(key, 7));
      break;
    case "Home":
      moveFocus(mondayKeyOf(key));
      break;
    case "End":
      moveFocus(addUtcDays(mondayKeyOf(key), 6));
      break;
    case "PageUp":
      stepMonth(e.shiftKey ? -12 : -1);
      break;
    case "PageDown":
      stepMonth(e.shiftKey ? 12 : 1);
      break;
    case "Enter":
    case " ":
      if (slotIsFuture(key)) break;
      // Enter on an already-selected cell confirms it, so select-then-confirm
      // is one-handed rather than a trip to the panel.
      if (selectedDayKey === key) void onConfirm();
      else select(key);
      break;
    default:
      return;
  }
  e.preventDefault();
}

// Only keyboard navigation moves the DOM focus ring; a pointer click leaves it
// where it was.
$effect(() => {
  const key = focusedDayKey;
  if (!shouldStealFocus) return;
  const el = document.querySelector<HTMLButtonElement>(`[data-daykey="${key}"]`);
  el?.focus();
});

// ── Selection panel ─────────────────────────────────────────────────────────

const selectedRecap = $derived(selectedDayKey ? recapAt(selectedDayKey) : undefined);
const selectedKind = $derived(selectedDayKey ? recapKind(selectedRecap, selectedDayKey) : "empty");
const selectedIsFuture = $derived(selectedDayKey ? slotIsFuture(selectedDayKey) : false);
const selectedIsCurrent = $derived(
  selectedDayKey ? isCurrentPeriod(period, selectedDayKey, dayKeyToUtcDate(nowKey)) : false,
);
const selectedLabel = $derived(selectedDayKey ? formatSlot(period, selectedDayKey) : "");
const currentNoun = $derived(period === "daily" ? "today's" : "this week's");

async function onConfirm(): Promise<void> {
  const dayKey = selectedDayKey;
  if (!dayKey || generating || selectedIsFuture) return;
  generating = true;
  try {
    // The current-period carve-out lives here and nowhere else.
    // `selectionBoundaries` returns null for a live window, which omits
    // periodStart/periodEnd from the body — the server then rolls its own
    // [00:00Z, now] window and takes the supersede-and-regenerate path,
    // byte-identical to the floating "Generate today's recap" pill. A past
    // window is closed and immutable, so it goes out pinned and idempotent.
    const b = selectionBoundaries(period, dayKey, new Date());
    if (b === null) {
      // `b ?? undefined`, never `b ?? {}` — under exactOptionalPropertyTypes
      // the store does the conditional-assign dance itself and must not be
      // handed `periodStart: undefined`.
      const res = await generateRecap(repoId, period, undefined);
      if (res?.recapId) onGenerated?.(res.recapId, true);
      return;
    }
    // A past slot that already holds a recap must never re-issue a pinned
    // generate: the server would treat it as idempotent and hand back the same
    // id, so the button would do visibly nothing. Route it through the
    // explicit regenerate endpoint instead.
    const existing = recapAt(dayKey);
    const res = existing
      ? await regenerateRecap(existing.id)
      : await generateRecap(repoId, period, b);
    if (res?.recapId) onGenerated?.(res.recapId, false);
  } finally {
    generating = false;
  }
}

function openSelected(): void {
  const r = selectedRecap;
  if (r) void goto(`/repo/${repoId}/recaps/${r.id}`);
}
</script>

<section class="recap-calendar">
	<header class="calendar-section-header">
		<span class="eyebrow">Archive</span>
		<h2>{period === "daily" ? "Daily" : "Weekly"} recaps</h2>
	</header>

	<div class="calendar-layout">
		<div class="calendar-main">
			<div class="calendar-nav">
				<button
					type="button"
					class="nav-btn"
					onclick={() => stepMonth(-1)}
					aria-label="Previous month"
					use:gsapPress
				>
					<CaretLeft size={14} aria-hidden="true" />
				</button>
				<span class="month-label" aria-live="polite">{monthLabel}</span>
				<button
					type="button"
					class="nav-btn"
					onclick={() => stepMonth(1)}
					disabled={!canGoNext}
					aria-label="Next month"
					use:gsapPress
				>
					<CaretRight size={14} aria-hidden="true" />
				</button>
				<button type="button" class="today-btn" onclick={jumpToToday} use:gsapPress>
					Today
				</button>
			</div>

			{#key viewMonth}
				<div class="grid-wrap" in:gsapFade>
					<table
						class="calendar-grid"
						role="grid"
						aria-label="{period === 'daily' ? 'Daily' : 'Weekly'} recap calendar, {monthLabel} UTC"
						onkeydown={onGridKeydown}
					>
						<thead>
							<tr>
								{#each weekdayLabels as label (label)}
									<th scope="col" role="columnheader" class="weekday">{label}</th>
								{/each}
							</tr>
						</thead>
						<tbody>
							{#each grid.weeks as week (week[0])}
								{@const mondayKey = week[0] ?? ""}
								{@const weekActive =
									period === "weekly" &&
									(hoverWeekKey === mondayKey ||
										(selectedDayKey !== null && mondayKeyOf(selectedDayKey) === mondayKey))}
								<tr
									class="week-row"
									class:week-row--active={weekActive}
									aria-label={period === "weekly" ? `Week of ${formatSlot("daily", mondayKey)}` : undefined}
									onpointerenter={() => {
										if (period === "weekly") hoverWeekKey = mondayKey;
									}}
									onpointerleave={() => {
										if (period === "weekly" && hoverWeekKey === mondayKey) hoverWeekKey = null;
									}}
								>
									{#each week as dayKey (dayKey)}
										{@const recap = recapAt(dayKey)}
										{@const kind = recapKind(recap, dayKey)}
										{@const future = slotIsFuture(dayKey)}
										{@const selected =
											selectedDayKey !== null &&
											slotKeyFor(period, selectedDayKey) === slotKeyFor(period, dayKey)}
										<td role="gridcell" class="cell-wrap" aria-selected={selected}>
											<button
												type="button"
												data-daykey={dayKey}
												class="cell"
												class:cell--outside={monthKeyOf(dayKey) !== viewMonth}
												class:cell--future={dayKey > nowKey}
												class:cell--today={isToday(dayKey)}
												class:cell--complete={kind === "complete"}
												class:cell--generating={kind === "generating"}
												class:cell--error={kind === "error"}
												class:cell--quiet={kind === "quiet"}
												class:cell--active={recap !== undefined && recap.id === activeRecapId}
												class:cell--selected={selected}
												class:cell--week-start={period === "weekly" && dayKey === mondayKey}
												class:cell--week-end={period === "weekly" && dayKey === addUtcDays(mondayKey, 6)}
												tabindex={dayKey === focusedDayKey ? 0 : -1}
												aria-disabled={future}
												aria-current={isToday(dayKey) ? "date" : undefined}
												aria-label={cellLabel(dayKey)}
												title={kind === "error" ? (recap?.errorMessage ?? undefined) : undefined}
												onclick={() => onCellClick(dayKey)}
												use:gsapPress
											>
												<span class="cell-num">{dayNumber(dayKey)}</span>
												<span class="cell-mark">
													{#if kind === "generating"}
														<Spinner size={10} class="motion-essential-spin" aria-hidden="true" />
													{:else if kind === "error"}
														<WarningCircle size={10} aria-hidden="true" />
													{:else if kind === "quiet"}
														<span class="mark-dash"></span>
													{:else if kind === "complete"}
														<span class="mark-dot"></span>
													{:else if monthPending}
														<span class="mark-skeleton"></span>
													{/if}
												</span>
											</button>
										</td>
									{/each}
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/key}

			<p class="calendar-footer">
				<CalendarDots size={12} aria-hidden="true" />
				<span>Windows are UTC. Click a {period === "daily" ? "day" : "week"} to read or generate its recap.</span>
			</p>
		</div>

		<aside class="calendar-panel" aria-live="polite">
			{#if !selectedDayKey}
				<p class="panel-hint">
					Pick a {period === "daily" ? "day" : "week"} to read or generate its recap.
				</p>
			{:else}
				<p class="panel-window">{selectedLabel}</p>

				{#if selectedIsFuture}
					<p class="panel-hint">Nothing has happened yet.</p>
				{:else if selectedKind === "generating"}
					<Badge variant="secondary">
						<Spinner class="motion-essential-spin" />
						generating
					</Badge>
					<div class="panel-actions">
						<button type="button" class="panel-btn panel-btn--primary" onclick={openSelected} use:gsapPress>
							Open recap
						</button>
					</div>
				{:else if selectedRecap}
					{#if selectedKind === "error"}
						<Badge variant="destructive" title={selectedRecap.errorMessage ?? undefined}>
							<WarningCircle />
							failed
						</Badge>
					{:else if selectedKind === "quiet"}
						<Badge variant="outline">no activity</Badge>
					{:else}
						<Badge variant="outline">complete</Badge>
					{/if}
					<RecapStats stats={selectedRecap.summaryStats} />
					<div class="panel-actions">
						<button type="button" class="panel-btn panel-btn--primary" onclick={openSelected} use:gsapPress>
							Open recap
						</button>
						<button
							type="button"
							class="panel-btn"
							onclick={onConfirm}
							disabled={generating}
							use:gsapPress
						>
							{#if generating}
								<Spinner size={13} class="motion-essential-spin" aria-hidden="true" />
							{:else}
								<PenNib size={13} aria-hidden="true" />
							{/if}
							{selectedIsCurrent ? `Regenerate ${currentNoun} recap` : "Regenerate"}
						</button>
					</div>
					{#if selectedIsCurrent}
						<p class="panel-note">Replaces {currentNoun} recap. Covers 00:00 UTC → now.</p>
					{/if}
				{:else}
					<div class="panel-actions">
						<button
							type="button"
							class="panel-btn panel-btn--primary"
							onclick={onConfirm}
							disabled={generating}
							use:gsapPress
						>
							{#if generating}
								<Spinner size={13} class="motion-essential-spin" aria-hidden="true" />
							{:else}
								<PenNib size={13} aria-hidden="true" />
							{/if}
							{selectedIsCurrent
								? `Generate ${currentNoun} recap`
								: `Generate recap for ${selectedLabel}`}
						</button>
					</div>
					{#if selectedIsCurrent}
						<p class="panel-note">Covers 00:00 UTC → now.</p>
					{/if}
				{/if}
			{/if}
		</aside>
	</div>
</section>

<style>
	/* Section chrome is lifted verbatim from the archive list this replaces so
	   the page rhythm below the recap is unchanged. */
	.recap-calendar {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		margin-top: 3rem;
		padding-top: 1.5rem;
		border-top: 1px solid var(--color-border-subtle);
	}

	.calendar-section-header {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}

	.calendar-section-header h2 {
		margin: 0;
		font-size: 1.125rem;
		font-weight: 500;
		letter-spacing: -0.02em;
		color: var(--color-text-primary);
	}

	.eyebrow {
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		font-weight: 500;
		text-transform: uppercase;
		letter-spacing: 0.18em;
		color: var(--color-text-muted);
	}

	.calendar-layout {
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
	}

	/* Beside the grid once there's room. Stacking below at every width would
	   make the page jump on each click, because the panel's height varies by
	   state. */
	@media (min-width: 900px) {
		.calendar-layout {
			flex-direction: row;
			align-items: flex-start;
			gap: 2rem;
		}

		.calendar-panel {
			flex: 1;
			min-width: 0;
			padding-top: 2.25rem;
		}
	}

	.calendar-main {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		width: 100%;
		max-width: 34rem;
	}

	.calendar-nav {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.nav-btn,
	.today-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		background: transparent;
		border: 1px solid var(--color-border-subtle);
		border-radius: 0.375rem;
		color: var(--color-text-secondary);
		cursor: pointer;
		transition: background var(--duration-quick) var(--ease-out-expo);
	}

	.nav-btn {
		width: 1.75rem;
		height: 1.75rem;
	}

	.today-btn {
		margin-left: auto;
		height: 1.75rem;
		padding: 0 0.625rem;
		font-size: 0.75rem;
		font-weight: 500;
	}

	.nav-btn:hover:not(:disabled),
	.today-btn:hover {
		background: var(--color-bg-tertiary);
		color: var(--color-text-primary);
	}

	.nav-btn:disabled {
		opacity: 0.35;
		cursor: default;
	}

	.nav-btn:focus-visible,
	.today-btn:focus-visible,
	.panel-btn:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: 2px;
	}

	.month-label {
		font-size: 0.875rem;
		font-weight: 500;
		color: var(--color-text-primary);
	}

	.calendar-grid {
		width: 100%;
		border-collapse: separate;
		border-spacing: 0.1875rem;
		table-layout: fixed;
	}

	.weekday {
		padding-bottom: 0.25rem;
		font-family: var(--font-mono);
		font-size: 0.625rem;
		font-weight: 500;
		text-transform: uppercase;
		letter-spacing: 0.12em;
		color: var(--color-text-muted);
	}

	.cell-wrap {
		padding: 0;
	}

	/* A real table (rather than CSS-grid divs) specifically so weekly mode has
	   a row element to hang the whole-week highlight on. */
	.week-row--active .cell:not(.cell--future) {
		background: var(--color-bg-tertiary);
	}

	.cell {
		position: relative;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.125rem;
		width: 100%;
		aspect-ratio: 1;
		max-height: 2.75rem;
		padding: 0;
		background: var(--color-bg-secondary);
		border: 1px solid transparent;
		border-radius: 0.375rem;
		color: var(--color-text-secondary);
		cursor: pointer;
		transition:
			background var(--duration-quick) var(--ease-out-expo),
			border-color var(--duration-quick) var(--ease-out-expo);
	}

	.cell:hover:not([aria-disabled="true"]) {
		background: var(--color-bg-tertiary);
	}

	.cell:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: 1px;
	}

	.cell--outside {
		opacity: 0.4;
	}

	.cell--future {
		opacity: 0.25;
		cursor: default;
	}

	.cell--today {
		border-color: var(--color-accent);
	}

	.cell--selected,
	.cell--active {
		background: var(--color-bg-tertiary);
		border-color: var(--color-accent);
	}

	.cell--error {
		border-color: var(--color-danger);
	}

	.cell-num {
		font-family: var(--font-mono);
		font-size: 0.75rem;
		font-variant-numeric: tabular-nums;
		line-height: 1;
	}

	.cell--complete .cell-num,
	.cell--today .cell-num {
		color: var(--color-text-primary);
	}

	.cell-mark {
		display: flex;
		align-items: center;
		justify-content: center;
		height: 0.5rem;
		color: var(--color-text-muted);
	}

	.mark-dot {
		width: 0.3125rem;
		height: 0.3125rem;
		border-radius: 50%;
		background: var(--color-accent);
	}

	.mark-dash {
		width: 0.4375rem;
		height: 1px;
		background: var(--color-text-muted);
	}

	.mark-skeleton {
		width: 0.3125rem;
		height: 0.3125rem;
		border-radius: 50%;
		background: var(--color-border-subtle);
	}

	.cell--error .cell-mark {
		color: var(--color-danger);
	}

	.calendar-footer {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		margin: 0;
		font-size: 0.6875rem;
		color: var(--color-text-muted);
	}

	.calendar-panel {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.625rem;
	}

	.panel-window {
		margin: 0;
		font-family: var(--font-mono);
		font-size: 0.8125rem;
		color: var(--color-text-primary);
	}

	.panel-hint,
	.panel-note {
		margin: 0;
		font-size: 0.75rem;
		line-height: 1.5;
		color: var(--color-text-muted);
		max-width: 26rem;
	}

	.panel-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.panel-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		height: 1.875rem;
		padding: 0 0.75rem;
		background: var(--color-bg-secondary);
		border: 1px solid var(--color-border-subtle);
		border-radius: 0.375rem;
		font-size: 0.75rem;
		font-weight: 500;
		color: var(--color-text-primary);
		cursor: pointer;
		transition: background var(--duration-quick) var(--ease-out-expo);
	}

	.panel-btn:hover:not(:disabled) {
		background: var(--color-bg-tertiary);
	}

	.panel-btn:disabled {
		opacity: 0.5;
		cursor: default;
	}

	/* The accent-chip tokens rather than a flat `--color-accent` fill: the
	   accent flips from dark teal (light theme) to light teal (dark theme), so
	   any fixed foreground colour fails contrast in one of them. */
	.panel-btn--primary {
		background: var(--color-accent-chip-bg);
		border-color: var(--color-accent-chip-border);
		color: var(--color-accent-chip-fg);
	}

	.panel-btn--primary:hover:not(:disabled) {
		background: var(--color-accent-chip-bg-hover);
		border-color: var(--color-accent-chip-border-hover);
	}
</style>
