<script lang="ts">
/*
 * One row of the repo homepage's queue.
 *
 * Anatomy is GitHub's, because that is the one PR row every reviewer already
 * knows how to read: state icon, then the bold title on its own line, then a
 * metadata sentence — `#num · who · when` — underneath. Nothing invented sits
 * in a slot GitHub uses for something else.
 *
 * Where it departs from GitHub, it departs on purpose:
 *
 * - The state icon is *not* green. Every PR on this surface is open, so nine
 *   green glyphs carry no information; colour is spent instead on the one
 *   thing that differs between rows.
 * - GitHub marks a row with unseen activity using a 4px blue side-stripe.
 *   Side-stripes are banned by the design system, so "you read this, then they
 *   pushed" is a full-row tint plus a spelled-out clause.
 * - Read state rides on title weight, the notification-inbox convention, not
 *   on a second glyph. One icon vocabulary per row.
 * - The branch shows only when it is information. A stacked PR's base is; the
 *   source branch of a PR targeting `main` is a restatement of the title.
 */

import GitPullRequest from "phosphor-svelte/lib/GitPullRequest";
import Avatar from "$lib/components/recaps/Avatar.svelte";
import { REASON_LABEL, type TaggedRow } from "$lib/prs/tagged-prs";
import { getVisitState, type VisitState } from "$lib/stores/pr-visits.svelte";
import { selectPr } from "$lib/stores/prs.svelte";
import { setSidebarView } from "$lib/stores/sidebar.svelte";
import { formatRelativeTime } from "$lib/utils/format-relative-time";

interface Props {
  row: TaggedRow;
  /** Lets the row drop the "→ main" that would otherwise repeat under nearly every title. */
  defaultBranch: string;
  /** False while a reason filter is active, where the per-row reason is noise. */
  showReason: boolean;
}

let { row, defaultBranch, showReason }: Props = $props();

const pr = $derived(row.pr);
const visit = $derived(getVisitState(pr.id, pr.headSha));
const isStacked = $derived(pr.targetBranch !== defaultBranch);

/**
 * `updatedAt` is typed `string` but is a `Date` after an Eden fetch and a
 * `string` after an SSE broadcast, in the same array — see `timeOf` in
 * `$lib/prs/tagged-prs`. `String()` gives `Date.parse` something it accepts
 * either way.
 */
const updatedAt = $derived(String(pr.updatedAt));

/** Absolute timestamp for the hover title; falls back to the raw value. */
const updatedAtExact = $derived.by(() => {
  const ms = Date.parse(updatedAt);
  return Number.isNaN(ms) ? updatedAt : new Date(ms).toLocaleString();
});

const VISIT_LABEL: Record<VisitState, string> = {
  unvisited: "Not opened yet",
  visited: "Already opened",
  moved: "New commits since you last opened this",
};

function onNav(event: MouseEvent): void {
  // Let the browser handle modified and non-primary clicks so cmd-click,
  // middle-click and "open in new window" keep working.
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
  event.preventDefault();
  void selectPr(pr.id);
  setSidebarView("files");
}
</script>

<li class="row row--{visit}" class:row--draft={pr.isDraft}>
	<a class="link" href="/review/{pr.id}" title={pr.title} onclick={onNav}>
		<span class="state" aria-hidden="true">
			<GitPullRequest size={15} />
		</span>

		<span class="body">
			<span class="title">{pr.title}</span>

			<!--
				Separators are `::before` pseudo-elements on the clause they
				introduce, not siblings. A clause that a container query hides
				takes its own "·" with it, and the row sheds five DOM nodes.
			-->
			<span class="meta">
				<Avatar handle={pr.authorLogin} avatarContent={pr.authorAvatarContent} size={14} />
				<span class="author">{pr.authorLogin}</span>
				<span class="num led">#{pr.externalId}</span>
				<span class="when led" title={updatedAtExact}>
					updated {formatRelativeTime(updatedAt)}
				</span>

				{#if pr.isDraft}
					<span class="clause led">Draft</span>
				{/if}

				<!--
					The loudest thing on the row when true, because it is the only
					state on this surface that is unambiguously stale-to-you.
				-->
				{#if visit === "moved"}
					<span class="clause clause--attention led">New commits</span>
				{/if}

				<!--
					Source truncates, target never does. When the arrow is there the
					target *is* the information, so eliding it
					("iam/3-authn-wiring → i…") is worse than showing no branch.
				-->
				{#if isStacked}
					<span class="branch led" title="{pr.sourceBranch} → {pr.targetBranch}">
						<span class="branch-src">{pr.sourceBranch}</span>
						<span class="branch-arrow" aria-hidden="true">&rarr;</span>
						<span class="branch-target">{pr.targetBranch}</span>
					</span>
				{/if}
			</span>
		</span>

		<span class="sr-only">{VISIT_LABEL[visit]}</span>
	</a>

	{#if showReason}
		<span class="reason reason--{row.reason}">{REASON_LABEL[row.reason]}</span>
	{/if}
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
		/* Matches `.prose-table`'s 6%, the visual ancestor of this frame. */
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

	.link {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
		flex: 1 1 auto;
		min-width: 0;
		color: inherit;
		text-decoration: none;
	}

	/* Stretches the link over the whole row: one real anchor, so keyboard
	   activation, cmd-click and "copy link address" all work, while the click
	   target is the full row. Any control added to a row later needs
	   `position: relative; z-index: 1` or this overlay swallows it. */
	.link::after {
		content: "";
		position: absolute;
		inset: 0;
	}

	.link:focus-visible {
		outline: none;
	}

	.row:has(.link:focus-visible) {
		outline: 2px solid var(--color-accent);
		outline-offset: -2px;
	}

	.state {
		display: inline-flex;
		align-items: center;
		flex-shrink: 0;
		/* Optical: the glyph's mass sits low, so nudge it onto the title's
		   cap-height rather than its line box. */
		height: 1.3125rem;
		color: var(--color-text-secondary);
	}

	.row--visited .state,
	.row--draft .state {
		color: var(--color-text-muted);
	}

	.body {
		display: flex;
		flex-direction: column;
		gap: 0.1875rem;
		min-width: 0;
		flex: 1 1 auto;
	}

	/* A step below the section heading. The system's 0.9375rem "Title" step ties
	   the heading exactly, which read as nine sibling headings rather than as a
	   list under one; weight carries the emphasis instead. */
	.title {
		font-size: 0.875rem;
		font-weight: 600;
		line-height: 1.4;
		letter-spacing: -0.01em;
		color: var(--color-text-primary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* Opened rows recede, like a read row in a notification inbox. Weight is
	   the redundant channel for anyone who can't see the colour step. */
	.row--visited .title {
		font-weight: 500;
		color: var(--color-text-secondary);
	}

	.meta {
		display: flex;
		align-items: center;
		flex-wrap: nowrap;
		gap: 0.3125rem;
		min-width: 0;
		/* Nothing may escape the row: every clause but the branch is
		   `flex-shrink: 0`, so a container narrow enough to squeeze them clips
		   rather than spilling over the frame. */
		overflow: hidden;
		font-size: 0.75rem;
		line-height: 1.4;
		/* ink-secondary, not ink-muted: muted is 2.7:1 on warm paper and the
		   system reserves it for placeholders and disabled labels. This line is
		   metadata, which is ink-secondary's named job. */
		color: var(--color-text-secondary);
	}

	.author {
		flex-shrink: 0;
		font-weight: 500;
	}

	/* The leading "·". `content: x / ""` gives it an empty accessible name so
	   assistive tech reads the sentence, not a run of middle dots. */
	.led::before {
		content: "\00b7" / "";
		margin-right: 0.3125rem;
		opacity: 0.5;
	}

	.num {
		flex-shrink: 0;
		font-variant-numeric: tabular-nums;
	}

	.when {
		flex-shrink: 0;
	}

	.clause {
		flex-shrink: 0;
	}

	/* The only coloured text in the component, and it marks exactly one state:
	   you read this PR, then the author pushed. Measured 5.99:1 on warm paper
	   and 8.4:1 on the midnight canvas. */
	.clause--attention {
		font-weight: 600;
		color: var(--color-accent);
	}

	/* Lifted above the anchor's overlay so a truncated branch stays hoverable
	   for its tooltip. Clicks here still open the PR — the overlay is beneath,
	   not instead. */
	.branch {
		position: relative;
		z-index: 1;
		display: flex;
		align-items: baseline;
		gap: 0.25rem;
		min-width: 0;
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		opacity: 0.85;
	}

	/* `white-space: nowrap` is what makes the ellipsis work at all. Without it
	   the branch name wraps instead, and once flex has shrunk this box toward
	   zero it wraps to three lines and inflates the whole row from 55px to
	   83px. */
	.branch-src {
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	.branch-arrow,
	.branch-target {
		flex-shrink: 0;
	}

	.branch-target {
		color: var(--color-text-secondary);
	}

	/*
	 * The reason, spelled out on the right rail.
	 *
	 * As text it needs neither a column header nor a legend, and right-aligned
	 * it forms the scannable vertical column the old "WHY" glyph gutter was
	 * reaching for. Only the actionable reason takes colour, and it takes the
	 * "your turn" marker rather than the brand accent, so the accent budget is
	 * untouched.
	 */
	.reason {
		flex-shrink: 0;
		align-self: center;
		font-size: 0.6875rem;
		font-weight: 500;
		line-height: 1.4;
		white-space: nowrap;
		color: var(--color-text-secondary);
	}

	/* Weight and ink, not colour. The actionable reason still leads the rail,
	   but the warm orange is reserved for the one state that is genuinely
	   time-sensitive — see `.clause--attention`. This mirrors how the toolbar
	   marks its active filter, so the component has one emphasis language. */
	.reason--review {
		color: var(--color-text-primary);
		font-weight: 600;
	}

	/*
	 * Two things give way as the container narrows, in order of how little they
	 * cost. Both stay in the DOM (visually hidden) so screen-reader output is
	 * identical at every width.
	 *
	 * The reason goes first: it competes with the title for width and the
	 * toolbar already names the active filter. The branch goes next, because
	 * below ~460px it has nothing left to say — an ellipsed source plus a
	 * clipped target is worse than no branch at all.
	 */
	@container tagged (max-width: 520px) {
		.reason {
			position: absolute;
			width: 1px;
			height: 1px;
			overflow: hidden;
			clip-path: inset(50%);
			white-space: nowrap;
		}
	}

	@container tagged (max-width: 460px) {
		.branch {
			position: absolute;
			width: 1px;
			height: 1px;
			overflow: hidden;
			clip-path: inset(50%);
		}
	}
</style>
