<script lang="ts">
/*
 * RepoTaggedPrs — the repo homepage's queue of PRs that involve the viewer.
 *
 * A list with a toolbar, not a data grid. The queue is a handful of rows the
 * reader triages by eye; a `<thead>` with per-column sort buttons is apparatus
 * that a spreadsheet needs and a queue does not, and it forced a column named
 * "Why" over a gutter of glyphs that needed their own legend.
 *
 * So the shape is GitHub's `/pulls` list, which is the one PR list every
 * reviewer can already read: a toolbar strip attached to the frame carries the
 * filters and the sort, and each row below it is `state icon → title → #num ·
 * who · when`. See TaggedPrRow for where the row deliberately improves on
 * GitHub rather than copying it.
 *
 * Frame styling still borrows `.prose-table` (lib/styles/prose.css) — same
 * hairline, same radius, same `bg-secondary` header band, same 6% row hover —
 * so this reads as the same family as the app's other bordered surface.
 *
 * No entrance motion. This is a surface the user lands on many times a day;
 * a staggered reveal on every render (and on every SSE tick that re-keys a
 * row) is a tax, not polish. Motion here is state only: row hover and the
 * toolbar's press.
 */

import Tray from "phosphor-svelte/lib/Tray";
import TaggedPrRow from "$lib/components/repo/TaggedPrRow.svelte";
import TaggedPrToolbar from "$lib/components/repo/TaggedPrToolbar.svelte";
import {
  compareTaggedRows,
  REASON_LABEL,
  sortOptionFor,
  type TaggedReason,
  type TaggedSortId,
  toTaggedRows,
} from "$lib/prs/tagged-prs";
import { getCurrentUserLogin } from "$lib/stores/auth.svelte";
import { getTaggedPrs, getTaggedPrsResolved } from "$lib/stores/prs.svelte";

interface Props {
  repoId: string;
  /**
   * The repo's default branch. Lets each row drop the "→ main" that would
   * otherwise repeat under nearly every title.
   */
  defaultBranch: string;
}

let { repoId, defaultBranch }: Props = $props();

// ── State ───────────────────────────────────────────────────────────────────
// All component-local: nothing else in the app needs the sort or the filter.

/**
 * The reason to narrow to, or `null` for "All".
 *
 * Single-select, not a `Set`: `reasonFor` makes the three reasons mutually
 * exclusive by construction, so a multi-select over them only ever expressed
 * "all" in a more expensive way.
 */
let activeReason = $state<TaggedReason | null>(null);
let sortId = $state<TaggedSortId>("relevance");
// Seeded empty so the region stays silent on first paint and speaks only in
// response to a user action.
let srMessage = $state("");

const login = $derived(getCurrentUserLogin());
const resolved = $derived(getTaggedPrsResolved());
const allRows = $derived(toTaggedRows(getTaggedPrs(repoId), login));

const counts = $derived.by(() => {
  const tally: Record<TaggedReason, number> = { review: 0, yours: 0, mentioned: 0 };
  for (const row of allRows) tally[row.reason] += 1;
  return tally;
});

const rows = $derived.by(() => {
  const shown = activeReason === null ? allRows : allRows.filter((r) => r.reason === activeReason);
  const { key, dir } = sortOptionFor(sortId);
  // Never sort in place: `allRows` may be the array the derived above handed
  // out, and an in-place sort would mutate it under other readers.
  return [...shown].sort((a, b) => compareTaggedRows(a, b, key, dir));
});

const headline = $derived(
  allRows.length === 1
    ? "1 open pull request involves you"
    : `${allRows.length} open pull requests involve you`,
);

function announce(): void {
  const scope = activeReason === null ? "all" : REASON_LABEL[activeReason].toLowerCase();
  srMessage = `Showing ${rows.length} of ${allRows.length} pull requests (${scope}), sorted by ${sortOptionFor(sortId).label.toLowerCase()}.`;
}

function onReasonChange(reason: TaggedReason | null): void {
  activeReason = reason;
  announce();
}

function onSortChange(id: TaggedSortId): void {
  sortId = id;
  announce();
}

const SKELETON_ROWS = [0, 1, 2, 3];
</script>

<section class="tagged" aria-labelledby="tagged-heading">
	<h2 class="heading" id="tagged-heading">
		{resolved ? headline : "Loading pull requests…"}
	</h2>

	<div class="sr-only" role="status" aria-live="polite" aria-atomic="true">{srMessage}</div>

	{#if resolved && allRows.length === 0}
		<div class="blank">
			<Tray size={16} aria-hidden="true" />
			<div class="blank-body">
				<p class="blank-title">Nothing in this repo involves you.</p>
				<p class="blank-hint">
					Pull requests you opened, were asked to review, or were mentioned in show up
					here.
				</p>
			</div>
		</div>
	{:else}
		<div class="frame" aria-busy={!resolved}>
			{#if resolved}
				<TaggedPrToolbar
					{counts}
					total={allRows.length}
					{activeReason}
					{onReasonChange}
					{sortId}
					{onSortChange}
				/>
			{/if}

			{#if !resolved}
				<ul class="list" aria-hidden="true">
					{#each SKELETON_ROWS as slot (slot)}
						<li class="skel-row">
							<span class="skel-bar skel-bar--title"></span>
							<span class="skel-bar skel-bar--meta"></span>
						</li>
					{/each}
				</ul>
			{:else if rows.length === 0}
				<p class="filtered-blank">
					<span role="status">No pull requests match this filter.</span>
					<button type="button" class="link-btn" onclick={() => onReasonChange(null)}>
						Show all
					</button>
				</p>
			{:else}
				<ul class="list">
					{#each rows as row (row.pr.id)}
						<TaggedPrRow {row} {defaultBranch} />
					{/each}
				</ul>
			{/if}
		</div>
	{/if}
</section>

<style>
	.tagged {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		/* Collapse is driven by the section's own width, not the viewport: the
		   main area shrinks whenever the right panel opens or the sidebar is
		   dragged wider. `width: 100%` is not optional — an inline-size
		   container reports no intrinsic width and would otherwise collapse
		   inside the page's flex column. */
		container-type: inline-size;
		container-name: tagged;
		width: 100%;
		min-width: 0;
	}

	/* A clear step above the 0.875rem row titles — a 15px heading over 15px
	   titles reads as a peer, not a header. */
	.heading {
		margin: 0;
		font-size: 1rem;
		font-weight: 600;
		color: var(--color-text-primary);
		letter-spacing: -0.01em;
	}

	.frame {
		border: 1px solid var(--color-border-subtle);
		border-radius: var(--radius-card);
		background: var(--color-bg-primary);
		/* Same Small tier as the recap card below it, so the two content cards
		   on this page sit at one elevation. */
		box-shadow: var(--color-shadow-sm);
		/* Clips the toolbar's top corners and each row's hover fill to the
		   frame's radius, so no child needs a radius of its own. */
		overflow: hidden;
	}

	.list {
		margin: 0;
		padding: 0;
		list-style: none;
	}

	/* ── Loading ────────────────────────────────────────────────────────── */

	/* Deliberately motionless: a static bar preserves the layout, reads as
	   "loading" on its own, and needs no reduced-motion carve-out. */
	.skel-row {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 0.6875rem var(--spacing-inset);
		border-top: 1px solid var(--color-border-subtle);
	}

	.skel-row:first-child {
		border-top: none;
	}

	.skel-bar {
		display: block;
		height: 10px;
		border-radius: 3px;
		background: color-mix(in srgb, var(--color-text-muted) 22%, transparent);
	}

	.skel-bar--title {
		width: 62%;
	}

	.skel-bar--meta {
		width: 34%;
		height: 7px;
	}

	/* ── Empty states ───────────────────────────────────────────────────── */

	.filtered-blank {
		margin: 0;
		padding: 1rem var(--spacing-inset);
		text-align: center;
		font-size: 0.8125rem;
		color: var(--color-text-muted);
	}

	.link-btn {
		margin-left: 0.5rem;
		border: none;
		background: none;
		padding: 0;
		color: var(--color-accent);
		font-family: inherit;
		font-size: 0.8125rem;
		font-weight: 500;
		cursor: pointer;
	}

	.link-btn:hover {
		text-decoration: underline;
	}

	.link-btn:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: 2px;
		border-radius: 2px;
	}

	.blank {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
		padding: 0.875rem 1rem;
		background: var(--color-bg-secondary);
		border: 1px solid var(--color-border-subtle);
		border-radius: var(--radius-card);
		color: var(--color-text-muted);
	}

	.blank-body {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		min-width: 0;
	}

	.blank-title {
		margin: 0;
		font-size: 0.8125rem;
		color: var(--color-text-secondary);
	}

	.blank-hint {
		margin: 0;
		font-size: 0.75rem;
		line-height: 1.45;
	}
</style>
