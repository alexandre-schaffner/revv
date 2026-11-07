<script lang="ts">
import type { ProjectRecapSummary, RecapPeriod } from "@revv/shared";
import CalendarDots from "phosphor-svelte/lib/CalendarDots";
import CaretLeft from "phosphor-svelte/lib/CaretLeft";
import CaretRight from "phosphor-svelte/lib/CaretRight";
import Spinner from "phosphor-svelte/lib/Spinner";
import WarningCircle from "phosphor-svelte/lib/WarningCircle";
import { untrack } from "svelte";
import { goto } from "$app/navigation";
import { gsapFade, gsapPress } from "$lib/motion";
import {
  addUtcDays,
  dayKeyToUtcDate,
  formatRecapRange,
  mondayKeyOf,
  monthGrid,
  monthKeyOf,
  recapSlotKey,
  shiftMonth,
  slotKeyFor,
  slotSpan,
  utcDateKey,
  utcDayKey,
  windowPath,
} from "$lib/recaps/period-window";
import { fetchRecapsForMonth, getMonthRecapsLoading } from "$lib/recaps/store.svelte";
import RecapButton from "./RecapButton.svelte";

/**
 * Month calendar over a repo's recaps. Every cell, filled or empty, is a
 * generation target, so gaps in history are visible and fillable.
 *
 * Everything here is UTC, always. A user at UTC+13 sees local 4 June while UTC
 * is still 3 June; if the today-ring followed local time they'd click what
 * looks like yesterday, hit the idempotent past-window path, and watch nothing
 * happen. Hence the `· UTC` marker in the footer, matching the eyebrow on the
 * recap hero.
 */
interface Props {
  repoId: string;
  period: RecapPeriod;
  /** All recaps for the repo (any period). The component filters internally. */
  recaps: ProjectRecapSummary[];
  /** The recap rendered above this calendar, highlighted in the grid. */
  activeRecapId?: string | null | undefined;
  /** Month/day the calendar opens on. Defaults to the active recap, else UTC today. */
  initialDayKey?: string | undefined;
  /** Fired when the calendar hands off to another view, so a host popover can
   *  close instead of hanging over the page it just navigated away from. */
  onLeave?: (() => void) | undefined;
}

let { repoId, period, recaps, activeRecapId = null, initialDayKey, onLeave }: Props = $props();

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
let focusedDayKey = $state(initialAnchor);
let hoverWeekKey = $state<string | null>(null);
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

/**
 * `monthGrid` always returns six rows so the fetch range is a constant 42
 * days. Only the last row can fall wholly in the next month (the first always
 * holds the 1st), and painted it reads, in weekly mode, as a selectable week
 * unrelated to the month in the label, so it is dropped. The grid then stands
 * 5 or 6 rows tall by month: the shift only follows a click on the month
 * arrows, which beats 47px of dead space in most months.
 */
const weeks = $derived(
  grid.weeks.filter(
    (week, i) => i < grid.weeks.length - 1 || week.some((k) => monthKeyOf(k) === viewMonth),
  ),
);

const weekdayLabels = $derived(
  (grid.weeks[0] ?? []).map((k) => WEEKDAY_FMT.format(dayKeyToUtcDate(k))),
);

/**
 * `slotKey → recap`, holding daily *and* weekly rows at once so toggling the
 * period costs nothing and triggers no refetch. When two rows share a slot
 * the newest generation wins.
 */
const slotIndex = $derived.by(() => {
  const map = new Map<string, ProjectRecapSummary>();
  for (const r of recaps) {
    const key = recapSlotKey(r);
    const existing = map.get(key);
    if (!existing || r.generatedAt > existing.generatedAt) map.set(key, r);
  }
  return map;
});

type SlotKind = "complete" | "generating" | "error" | "empty";

function recapKind(r: ProjectRecapSummary | undefined): SlotKind {
  if (!r) return "empty";
  if (r.status === "generating") return "generating";
  if (r.status === "error" || r.status === "stopped") return "error";
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
  const kind = recapKind(r);
  const state =
    kind === "complete"
      ? "complete"
      : kind === "generating"
        ? "generating"
        : kind === "error"
          ? "failed"
          : slotIsFuture(dayKey)
            ? "in the future"
            : "not generated";
  return `${formatRecapRange(slotSpan(period, dayKey))} — ${period} recap, ${state}`;
}

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
}

/**
 * Every cell is a link: a filled slot to its recap, an empty one to that
 * window's own page, which offers to generate it.
 */
function onCellClick(dayKey: string): void {
  if (slotIsFuture(dayKey)) return;
  shouldStealFocus = false;
  const recap = recapAt(dayKey);
  if (recap) openRecap(recap);
  else openWindow(dayKey);
}

/**
 * Navigate to a recap and let the host close. Clicking the recap already on
 * screen is a no-op beyond closing: on the period view its permalink is a
 * lateral move to the same content under a different URL.
 */
function openRecap(recap: ProjectRecapSummary): void {
  onLeave?.();
  if (recap.id === activeRecapId) return;
  void goto(`/repo/${repoId}/recaps/${recap.id}`);
}

function openWindow(dayKey: string): void {
  onLeave?.();
  void goto(windowPath(repoId, period, dayKey));
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
      onCellClick(key);
      break;
    default:
      return;
  }
  e.preventDefault();
}

$effect(() => {
  const key = focusedDayKey;
  if (!shouldStealFocus) return;
  const el = document.querySelector<HTMLButtonElement>(`[data-daykey="${key}"]`);
  el?.focus();
});
</script>

<section class="recap-calendar">
	<div class="calendar-block">
	<div class="calendar-toolbar">
		<div class="month-nav">
			<RecapButton icon onclick={() => stepMonth(-1)} aria-label="Previous month">
				<CaretLeft size={14} aria-hidden="true" />
			</RecapButton>
			<span class="month-label" aria-live="polite">{monthLabel}</span>
			<RecapButton icon onclick={() => stepMonth(1)} disabled={!canGoNext} aria-label="Next month">
				<CaretRight size={14} aria-hidden="true" />
			</RecapButton>
		</div>
		<RecapButton class="today-btn" onclick={jumpToToday}>Today</RecapButton>
	</div>

	<div class="calendar-body">
			{#key viewMonth}
				<div class="grid-wrap" in:gsapFade>
					<table
						class="calendar-grid"
						class:calendar-grid--weekly={period === "weekly"}
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
							{#each weeks as week (week[0])}
								{@const mondayKey = week[0] ?? ""}
								{@const weekActive = period === "weekly" && hoverWeekKey === mondayKey}
								<tr
									class="week-row"
									class:week-row--active={weekActive}
									aria-label={period === "weekly" ? `Week of ${formatRecapRange(slotSpan("daily", mondayKey))}` : undefined}
									onpointerenter={() => {
										if (period === "weekly" && !slotIsFuture(mondayKey)) hoverWeekKey = mondayKey;
									}}
									onpointerleave={() => {
										if (period === "weekly" && hoverWeekKey === mondayKey) hoverWeekKey = null;
									}}
								>
									{#each week as dayKey (dayKey)}
										{@const recap = recapAt(dayKey)}
										{@const kind = recapKind(recap)}
										{@const future = slotIsFuture(dayKey)}
										{@const isActive = recap !== undefined && recap.id === activeRecapId}
										<td role="gridcell" class="cell-wrap" aria-current={isActive ? "page" : undefined}>
											<button
												type="button"
												data-daykey={dayKey}
												class="cell"
												class:cell--outside={monthKeyOf(dayKey) !== viewMonth}
												class:cell--future={future}
												class:cell--today={isToday(dayKey)}
												class:cell--complete={kind === "complete"}
												class:cell--generating={kind === "generating"}
												class:cell--error={kind === "error"}
												class:cell--active={isActive}
												class:cell--week-start={period === "weekly" && dayKey === mondayKey}
												class:cell--week-end={period === "weekly" && dayKey === addUtcDays(mondayKey, 6)}
												tabindex={dayKey === focusedDayKey ? 0 : -1}
												aria-disabled={future}
												aria-current={isToday(dayKey) ? "date" : undefined}
												aria-label={cellLabel(dayKey)}
												title={recap?.status === "stopped" ? "Stopped" : kind === "error" ? (recap?.errorMessage ?? undefined) : undefined}
												onclick={() => onCellClick(dayKey)}
												use:gsapPress
											>
												<span class="cell-num">{dayNumber(dayKey)}</span>
												<span class="cell-mark">
													{#if kind === "generating"}
														<Spinner size={10} class="motion-essential-spin" aria-hidden="true" />
													{:else if kind === "error"}
														<WarningCircle size={10} aria-hidden="true" />
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
	</div>

	<p class="calendar-footer">
		<CalendarDots size={12} aria-hidden="true" />
		<span>Every window starts and ends at 00:00 UTC.</span>
	</p>
	</div>
</section>

<style>
	.recap-calendar {
		container-type: inline-size;
		container-name: recap-archive;
	}

	.calendar-block {
		display: flex;
		flex-direction: column;
		gap: 0.875rem;
		width: 100%;
	}

	.calendar-toolbar {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}

	.month-nav {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
	}

	.recap-calendar :global(.today-btn) {
		margin-left: auto;
	}

	.month-label {
		min-width: 7.5rem;
		font-size: 0.8125rem;
		font-weight: 500;
		color: var(--color-text-primary);
		text-align: center;
	}

	.calendar-body {
		width: 100%;
	}

	.calendar-grid {
		width: 100%;
		border-collapse: separate;
		border-spacing: 0.1875rem;
		table-layout: fixed;
	}

	/* Weekly mode closes the horizontal gap so a week reads as one continuous
	   band, which is what the user is picking. Cells keep transparent 1px side
	   borders, so backgrounds stay flush and only the band's outer edge shows
	   a rule. */
	.calendar-grid--weekly {
		border-spacing: 0 0.1875rem;
	}

	.weekday {
		padding-bottom: 0.375rem;
		font-family: var(--font-mono);
		font-size: 0.625rem;
		font-weight: 500;
		text-transform: uppercase;
		letter-spacing: 0.12em;
		color: var(--color-text-subtle);
	}

	.cell-wrap {
		padding: 0;
	}

	.cell {
		position: relative;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 100%;
		height: 2.75rem;
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

	.calendar-grid--weekly .cell {
		border-radius: 0;
	}

	.calendar-grid--weekly .cell--week-start {
		border-top-left-radius: 0.375rem;
		border-bottom-left-radius: 0.375rem;
	}

	.calendar-grid--weekly .cell--week-end {
		border-top-right-radius: 0.375rem;
		border-bottom-right-radius: 0.375rem;
	}

	.cell:hover:not([aria-disabled="true"]) {
		background: var(--color-bg-tertiary);
	}

	.cell:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: 1px;
		z-index: 1;
	}

	/* A real table, so weekly mode has a row element to hang the whole-week
	   highlight on. The fill follows the *slot*, not the day: in the current
	   week, later days are future days inside a selectable week.
	   `onpointerenter` keeps a wholly future week from lighting up. */
	.week-row--active .cell {
		background: var(--color-bg-tertiary);
	}

	/* Out-of-month days and slots that haven't happened drop their fill
	   rather than dimming: a faded filled cell still reads as content. In
	   weekly mode an out-of-month day keeps its fill, since the row is one
	   target; `.cell--future` is slot-scoped (`slotIsFuture`), so it blanks
	   whole future weeks and never days inside the current one. */
	.cell--outside,
	.cell--future {
		color: var(--color-text-muted);
	}

	.calendar-grid:not(.calendar-grid--weekly) .cell--outside,
	.cell--future {
		background: transparent;
	}

	.cell--future {
		cursor: default;
	}

	.cell--future:hover {
		background: transparent;
	}

	/* Today is a marked date, not a selection: the accent goes on the
	   numeral. The accent border is reserved for the recap on screen. */
	.cell--today .cell-num {
		color: var(--color-accent);
		font-weight: 600;
	}

	/* "You are here": the recap actually on screen. */
	.cell--active {
		background: var(--color-bg-tertiary);
		border-color: var(--color-accent);
	}

	/* Above `.cell--active` deliberately: a failed slot you are *reading*
	   should still show the "you are here" ring, and the ⚠ mark keeps the
	   failure legible either way. */
	.cell--error {
		border-color: var(--color-danger);
	}

	.calendar-grid--weekly .cell--error {
		border-left-color: transparent;
		border-right-color: transparent;
	}

	.calendar-grid--weekly .cell--error.cell--week-start {
		border-left-color: var(--color-danger);
	}

	.calendar-grid--weekly .cell--error.cell--week-end {
		border-right-color: var(--color-danger);
	}

	/* Daily mode has no slot/day split, so a future day keeps its empty look
	   even under the row highlight. */
	.calendar-grid:not(.calendar-grid--weekly) .week-row--active .cell--future {
		background: transparent;
	}

	/* One ring around the whole week: side borders only at the two ends. */
	.calendar-grid--weekly .cell--active {
		border-left-color: transparent;
		border-right-color: transparent;
	}

	.calendar-grid--weekly .cell--active.cell--week-start {
		border-left-color: var(--color-accent);
	}

	.calendar-grid--weekly .cell--active.cell--week-end {
		border-right-color: var(--color-accent);
	}

	.cell-num {
		font-family: var(--font-mono);
		font-size: 0.75rem;
		font-variant-numeric: tabular-nums;
		line-height: 1;
	}

	.cell--complete .cell-num {
		color: var(--color-text-primary);
	}

	/* Absolute, so an empty slot doesn't reserve a blank strip under its
	   numeral. */
	.cell-mark {
		position: absolute;
		bottom: 0.4375rem;
		left: 50%;
		transform: translateX(-50%);
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
		color: var(--color-text-subtle);
	}

</style>
