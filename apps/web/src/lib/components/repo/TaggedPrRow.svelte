<script lang="ts">
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
	 * The stretched anchor needs `position: relative` on a block `<li>`:
	 * WKWebView ignores it on `display: table-row`, which sends the overlay to
	 * a page-level containing block where the last row swallows every click.
	 */
	.row {
		position: relative;
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
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

	/* Read, then pushed to: a tint rather than GitHub's side-stripe (banned by
	   the design system), and never colour alone. Brand teal, the system's
	   "this is live" colour, not the warm orange: new commits are fresh work,
	   not a failure. */
	.row--moved {
		background: color-mix(in srgb, var(--color-accent) 6%, transparent);
	}

	.row--moved:hover {
		background: color-mix(in srgb, var(--color-accent) 10%, transparent);
	}

	.row:has(:global(:focus-visible)) {
		outline: 2px solid var(--color-accent);
		outline-offset: 1px;
	}
</style>
