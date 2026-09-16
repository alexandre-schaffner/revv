<script lang="ts">
/*
 * The list's toolbar strip.
 *
 * Anatomy is GitHub's `⑂ 60 Open  ✓ 2,638 Closed … Sort ▾` bar: filters on the
 * left as bare text-with-count, sort on the right as a menu. It sits attached
 * to the top of the frame rather than floating above it, which is what makes
 * the filters read as belonging to the list they narrow.
 *
 * Deliberately not chips. Chips with a glyph, a bold count and a label are a
 * stats row wearing a control's clothes, and they duplicate the count already
 * in the section heading. Weight alone carries the active state here.
 */

import * as Select from "$lib/components/ui/select";
import { gsapPress } from "$lib/motion";
import {
  REASON_LABEL,
  REASON_ORDER,
  sortOptionFor,
  TAGGED_SORT_OPTIONS,
  type TaggedReason,
  type TaggedSortId,
} from "$lib/prs/tagged-prs";

interface Props {
  counts: Record<TaggedReason, number>;
  total: number;
  /** `null` is the "All" filter, not "no selection". */
  activeReason: TaggedReason | null;
  onReasonChange: (reason: TaggedReason | null) => void;
  sortId: TaggedSortId;
  onSortChange: (id: TaggedSortId) => void;
}

let { counts, total, activeReason, onReasonChange, sortId, onSortChange }: Props = $props();

const sortLabel = $derived(sortOptionFor(sortId).label);
</script>

<div class="toolbar">
	<div class="filters" role="group" aria-label="Filter by why it involves you">
		<!--
			"All" is a real option rather than "click the active one to clear":
			the reasons are mutually exclusive, so a tri-state toggle would be
			guessing where an explicit fourth item is not.
		-->
		<button
			type="button"
			class="filter"
			class:filter--on={activeReason === null}
			aria-pressed={activeReason === null}
			onclick={() => onReasonChange(null)}
			use:gsapPress
		>
			<span>All</span>
			<span class="filter-count">{total}</span>
		</button>

		{#each REASON_ORDER as reason (reason)}
			<!--
				A zero-count filter stays live rather than `disabled`. It resolves
				to the empty state, which says so — and a control that greys out
				and un-greys itself on every SSE tick is worse than one that
				harmlessly returns nothing.
			-->
			<button
				type="button"
				class="filter"
				class:filter--on={activeReason === reason}
				aria-pressed={activeReason === reason}
				onclick={() => onReasonChange(reason)}
				use:gsapPress
			>
				<span>{REASON_LABEL[reason]}</span>
				<span class="filter-count">{counts[reason]}</span>
			</button>
		{/each}
	</div>

	<Select.Root
		type="single"
		value={sortId}
		onValueChange={(v) => onSortChange(sortOptionFor(v).id)}
	>
		<Select.Trigger class="tagged-sort-trigger" aria-label="Sort by">
			<span class="sort-value">{sortLabel}</span>
		</Select.Trigger>
		<Select.Content align="end">
			{#each TAGGED_SORT_OPTIONS as option (option.id)}
				<Select.Item value={option.id} class="text-xs">{option.label}</Select.Item>
			{/each}
		</Select.Content>
	</Select.Root>
</div>

<style>
	.toolbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		/* Wraps rather than truncates: below ~500px of container the sort menu
		   drops to its own line, which stays legible. Hiding labels to fit
		   would leave a row of bare numbers that mean nothing. */
		flex-wrap: wrap;
		gap: 0.25rem 0.5rem;
		padding: 0.3125rem 0.4375rem;
		background: var(--color-bg-secondary);
		border-bottom: 1px solid var(--color-border-subtle);
	}

	.filters {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.0625rem;
		min-width: 0;
	}

	.filter {
		display: inline-flex;
		align-items: baseline;
		gap: 0.3125rem;
		padding: 0.25rem 0.5rem;
		border: none;
		border-radius: 4px;
		background: transparent;
		/* These are controls whose labels *are* the queue's shape, so they read
		   at ink-secondary rather than the 2.6:1 ink-muted. */
		color: var(--color-text-secondary);
		font-family: inherit;
		font-size: 0.75rem;
		font-weight: 400;
		white-space: nowrap;
		cursor: pointer;
		transition:
			color var(--duration-instant) var(--ease-soft),
			background var(--duration-instant) var(--ease-soft);
	}

	.filter:hover:not(.filter--on) {
		background: color-mix(in srgb, var(--color-text-muted) 10%, transparent);
		color: var(--color-text-primary);
	}

	.filter:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: -1px;
	}

	/* Weight and ink carry the active state — no fill, no accent. Four filters
	   lit by colour would spend the accent budget on chrome that changes once
	   per session. */
	.filter--on {
		color: var(--color-text-primary);
		font-weight: 600;
	}

	.filter-count {
		font-variant-numeric: tabular-nums;
	}

	/* Strips the Select trigger back to GitHub's bare "Sort ▾": no border, no
	   fill, muted until hovered. The primitive keeps its keyboard and popover
	   behaviour. */
	:global(.tagged-sort-trigger) {
		height: 1.5rem;
		flex-shrink: 0;
		gap: 0.1875rem;
		padding: 0 0.25rem 0 0.375rem;
		border: none;
		background: transparent;
		color: var(--color-text-secondary);
		font-size: 0.75rem;
	}

	:global(.tagged-sort-trigger:hover) {
		background: color-mix(in srgb, var(--color-text-muted) 10%, transparent);
		color: var(--color-text-primary);
	}

	.sort-value {
		max-width: 11rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
