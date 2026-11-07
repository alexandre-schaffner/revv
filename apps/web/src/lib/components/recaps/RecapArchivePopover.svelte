<script lang="ts">
import type { ProjectRecapSummary, RecapPeriod } from "@revv/shared";
import CalendarDots from "phosphor-svelte/lib/CalendarDots";
import CaretDown from "phosphor-svelte/lib/CaretDown";
import * as Popover from "$lib/components/ui/popover";
import { RECAP_PERIOD_COPY } from "$lib/recaps/copy";
import RecapCalendar from "./RecapCalendar.svelte";

/**
 * Rendered through `Popover.Portal`: the recap route nests an
 * `overflow: hidden` wrapper around an `overflow-y: auto` scroller, so an
 * absolutely positioned panel would be clipped by both.
 */
interface Props {
  repoId: string;
  period: RecapPeriod;
  recaps: ProjectRecapSummary[];
  activeRecapId?: string | null;
  initialDayKey?: string | undefined;
  /** Trigger label. Defaults to the period's own noun. */
  label?: string | undefined;
}

let {
  repoId,
  period,
  recaps,
  activeRecapId = null,
  initialDayKey = undefined,
  label = undefined,
}: Props = $props();

let open = $state(false);

// Just "Archive": the trigger sits beside a "DAILY RECAP" eyebrow and the date
// itself, so repeating the period here is noise.
const triggerLabel = $derived(label ?? "Archive");
const unit = $derived(RECAP_PERIOD_COPY[period].unit);

// A hand-off out of the calendar (another recap, a generation) leaves this
// popover hanging over a page that is no longer underneath it.
function close(): void {
  open = false;
}
</script>

<Popover.Root bind:open>
	<Popover.Trigger class="archive-trigger" aria-label="Archive — browse recaps by {unit}">
		<CalendarDots size={14} aria-hidden="true" />
		<span>{triggerLabel}</span>
		<CaretDown size={11} aria-hidden="true" class="archive-trigger-caret" />
	</Popover.Trigger>

	<!-- `end`: the trigger sits at the right edge of the reading column, so the
	     panel has to open leftward from it or it runs off the pane. -->
	<Popover.Content align="end" sideOffset={8} class="archive-popover">
		<RecapCalendar
			{repoId}
			{period}
			{recaps}
			{activeRecapId}
			{initialDayKey}
			onLeave={close}
		/>
	</Popover.Content>
</Popover.Root>

<style>
	/* Same 28px bordered shape as `RecapButton`, written out here because
	   `Popover.Trigger` renders its own element and can only take a class. */
	:global(.archive-trigger) {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.375rem;
		min-height: 1.75rem;
		padding: 0.25rem 0.625rem;
		background: transparent;
		border: 1px solid var(--color-border-subtle);
		border-radius: 0.375rem;
		font: inherit;
		font-size: 0.75rem;
		font-weight: 500;
		line-height: 1.35;
		color: var(--color-text-secondary);
		cursor: pointer;
		transition:
			background var(--duration-quick) var(--ease-out-expo),
			border-color var(--duration-quick) var(--ease-out-expo),
			color var(--duration-quick) var(--ease-out-expo);
	}

	:global(.archive-trigger:hover),
	:global(.archive-trigger[data-state="open"]) {
		background: var(--color-bg-tertiary);
		color: var(--color-text-primary);
	}

	:global(.archive-trigger:focus-visible) {
		outline: 2px solid var(--color-accent);
		outline-offset: 2px;
	}

	:global(.archive-trigger-caret) {
		color: var(--color-text-muted);
		transition: transform var(--duration-quick) var(--ease-out-expo);
	}

	:global(.archive-trigger[data-state="open"] .archive-trigger-caret) {
		transform: rotate(180deg);
	}

	/* Wide enough for seven ~46px cells plus the popover's own padding; the
	   default `w-72` would have squeezed them to 34px. */
	:global(.archive-popover) {
		width: min(23rem, calc(100vw - 2rem));
		padding: 0.875rem;
	}
</style>
