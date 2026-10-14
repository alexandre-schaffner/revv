<script lang="ts">
/*
 * A PR on its own in the repo homepage's queue: a flat row at the level of
 * the page, parted from the next by a hairline. What it says is
 * `TaggedPrRowBody`'s; a PR in a stack is a card instead (`TaggedPrStack`).
 */

import TaggedPrRowBody from "$lib/components/repo/TaggedPrRowBody.svelte";
import type { TaggedRow } from "$lib/prs/tagged-prs";
import { getVisitState } from "$lib/stores/pr-visits.svelte";

interface Props {
  row: TaggedRow;
  /** Lets the row drop the "→ main" that would otherwise repeat under nearly every title. */
  defaultBranch: string;
}

let { row, defaultBranch }: Props = $props();

const visit = $derived(getVisitState(row.pr.id, row.pr.headSha));
</script>

<li class="row row--{visit}">
	<TaggedPrRowBody {row} {visit} showBranch={row.pr.targetBranch !== defaultBranch} />
</li>

<style>
	/*
	 * `position: relative` on the `<li>` is what makes the stretched-anchor
	 * pattern work here. It is honoured by every engine on a block element;
	 * the reason the previous `<table>` version could not use it is that
	 * WKWebView ignores it on `display: table-row` specifically, which sent the
	 * overlay to a page-level containing block and let the last row swallow
	 * clicks across the whole page.
	 */
	.row {
		position: relative;
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
		/* The system's list-row inset on all four sides. 8px vertical read as
		   nine crammed rows; 12px gives each one its own block of air without
		   turning the queue into a scroll. */
		padding: var(--spacing-inset);
		border-top: 1px solid var(--color-border-subtle);
		transition: background var(--duration-instant) var(--ease-soft);
	}

	.row:first-child {
		border-top: none;
	}

	.row:hover {
		background: color-mix(in srgb, var(--color-text-muted) 6%, transparent);
	}

	/* Read, then pushed to. A tint rather than GitHub's side-stripe, and never
	   colour alone — the "New commits" clause carries it in text. */
	/* Brand teal, not the warm "demands attention" orange. New commits are not
	   a failure — they are fresh work to read — and a red-orange row reads as an
	   error no matter what the label says. Teal is the system's "this is live,
	   this is where the work is" colour (streaming cursor, active file row, diff
	   selection), which is exactly the meaning wanted here. 6% sits between the
	   system's 4% severity wash and its 8% diff selection: enough to scan the
	   row at a glance, and cool enough that it cannot read as an alarm. */
	.row--moved {
		background: color-mix(in srgb, var(--color-accent) 6%, transparent);
	}

	.row--moved:hover {
		background: color-mix(in srgb, var(--color-accent) 10%, transparent);
	}

	/* The anchor inside is the focus target; the ring goes round the row. */
	.row:has(:global(:focus-visible)) {
		outline: 2px solid var(--color-accent);
		outline-offset: 1px;
	}
</style>
