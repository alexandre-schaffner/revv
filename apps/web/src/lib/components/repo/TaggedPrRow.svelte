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
 * - The row carries a diffstat, which GitHub's own list does not. "How big is
 *   it" is half of triage — a one-line revert and a thousand-line rewrite are
 *   not the same decision — and it is the only fact here you would otherwise
 *   have to open the PR to learn.
 */

import At from "phosphor-svelte/lib/At";
import Eye from "phosphor-svelte/lib/Eye";
import GitPullRequest from "phosphor-svelte/lib/GitPullRequest";
import Avatar from "$lib/components/recaps/Avatar.svelte";
import { REASON_LABEL, type TaggedReason, type TaggedRow } from "$lib/prs/tagged-prs";
import { getVisitState, type VisitState } from "$lib/stores/pr-visits.svelte";
import { selectPr } from "$lib/stores/prs.svelte";
import { setSidebarView } from "$lib/stores/sidebar.svelte";
import { formatRelativeTime } from "$lib/utils/format-relative-time";

interface Props {
  row: TaggedRow;
  /** Lets the row drop the "→ main" that would otherwise repeat under nearly every title. */
  defaultBranch: string;
}

let { row, defaultBranch }: Props = $props();

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

/**
 * GitHub's PR *list* endpoint omits `additions` / `deletions` / `changed_files`
 * — only the single-PR fetch carries them — so a freshly synced row holds the
 * column defaults until a detail fetch fills them in. Zeros here mean "not
 * known yet", not "an empty diff", and the clause stays out of the row rather
 * than asserting `0 files · +0 −0`.
 */
const hasSize = $derived(pr.changedFiles > 0 || pr.additions > 0 || pr.deletions > 0);

/** Thousands separators: a five-figure diff is exactly the one worth reading twice. */
function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * The whole fact in words, for the screen reader that never sees the column.
 *
 * It states a zero side the visual column omits, because "0 deletions" spoken
 * is information, where a red `−0` on screen is just a colour spent on
 * nothing. Separators included: `59,699` is announced as a number, `59699`
 * often as a digit run.
 */
const sizeLabel = $derived(
  `${fmt(pr.changedFiles)} ${pr.changedFiles === 1 ? "file" : "files"} changed, ${fmt(pr.additions)} additions, ${fmt(pr.deletions)} deletions`,
);

/**
 * The reason, as the row's leading glyph.
 *
 * `yours` is null on purpose, and the null is the point: the row already carries
 * the author's avatar and login, so on a page headed "N open pull requests
 * involve you" a row you wrote needs no further explanation. It keeps the
 * neutral pull-request mark, which is what "no special reason" looks like.
 *
 * The two that survive are the two nothing else on the row can tell you.
 */
const REASON_ICON: Record<TaggedReason, typeof Eye | null> = {
  review: Eye,
  yours: null,
  mentioned: At,
};

/*
 * Not gated on the active filter. A row's reason is a fact about the row, not
 * about which tab you happen to be standing on, and a glyph that appears and
 * disappears as you flick between "All" and "Review requested" makes the same
 * pull request look like two different things. The gate existed when this was a
 * text label in a rail — redundant once the tab named it, and it cost width —
 * and neither reason survives a glyph in a slot the row already had.
 */
const ReasonIcon = $derived(REASON_ICON[row.reason]);

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
		<!--
			The row's leading glyph, and the row's only marker of why it is in your
			queue.

			This slot used to be a constant: every pull request on this surface is
			open, so a pull-request symbol repeated down the column said nothing
			while occupying the most prominent scan position on the row. Spending it
			on the reason costs no width and leaves every other column anchored,
			which is why the reason is not a text label in a rail — a rail slot that
			is empty on half the rows reads as something stranded mid-row rather
			than as a column.

			`title` needs the stacking context: the anchor's stretched `::after`
			overlay sits above this span otherwise and swallows the hover, so the
			tooltip never fires. Clicks still open the PR; the overlay is beneath,
			not instead.
		-->
		<span
			class="state"
			class:state--reason={ReasonIcon !== null}
			title={ReasonIcon === null ? undefined : REASON_LABEL[row.reason]}
			aria-hidden="true"
		>
			{#if ReasonIcon !== null}
				<ReasonIcon size={15} weight="bold" />
			{:else}
				<GitPullRequest size={15} />
			{/if}
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

		<!--
			Spoken on every row, including the rows the glyph leaves neutral: the
			glyph's silence is a drawing decision, and a screen reader has no author
			column to glance at.
		-->
		<span class="sr-only">{REASON_LABEL[row.reason]}</span>

		<!--
			How big is it — the triage question the row could not answer, and the
			one it answers by *position* rather than by prose.

			It is a column, not the last clause of the metadata sentence, because
			a sentence puts the number at a different x on every row and a number
			you cannot line up is a number you have to read. Right-aligned with
			tabular figures, `495` and `7` compare at a glance.

			Two lines, on the body's two baselines: the file count rides the
			title, the line counts ride the metadata. The pairing is deliberate —
			file count is the headline (it predicts how many contexts a review
			has to load), line counts are its detail.

			Spelled out for assistive tech, because "+340 −88" read aloud as
			arithmetic is worse than silence.
		-->
		{#if hasSize}
			<span class="size">
				<span class="sr-only">{sizeLabel}</span>
				{#if pr.changedFiles > 0}
					<span class="size-files" aria-hidden="true">
						<span class="size-count">{fmt(pr.changedFiles)}</span>
						<span class="size-unit">{pr.changedFiles === 1 ? "file" : "files"}</span>
					</span>
				{/if}
				<!--
					A side is printed only when it moved. `−0` in deletion red says
					"danger, nothing happened"; the absence of the clause says the
					same thing without spending a colour on it.
				-->
				{#if pr.additions > 0 || pr.deletions > 0}
					<span class="size-lines" aria-hidden="true">
						{#if pr.additions > 0}
							<span class="add">+{fmt(pr.additions)}</span>
						{/if}
						{#if pr.deletions > 0}
							<span class="del">&minus;{fmt(pr.deletions)}</span>
						{/if}
					</span>
				{/if}
			</span>
		{/if}

		<span class="sr-only">{VISIT_LABEL[visit]}</span>
	</a>

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

	/*
	 * Brand teal, not the warm "demands attention" orange the system nominally
	 * reserves for a PR waiting on the viewer.
	 *
	 * The orange was tried and it reads as an error. That is the same finding
	 * `.clause--attention` records four rules down, and for the same reason: a
	 * review request is fresh work arriving, not a failure, and a warm orange
	 * glyph reads as a failure no matter what the tooltip says. Teal is the
	 * system's "this is live, this is where the work is" colour — the streaming
	 * cursor, the active file row, the diff selection — which is what a pull
	 * request waiting on you actually is.
	 *
	 * A row that is both review-requested and moved-since-you-read-it carries
	 * three teal marks: this glyph, the row wash, and the "New commits" clause.
	 * That is deliberate rather than a breach of the one-voice rule. They are
	 * not competing for different meanings; they are one row saying "this one,
	 * now" in three places, and that row should be the loudest in the queue.
	 *
	 * Colour is not carrying this alone — the glyph is a different drawing, not
	 * a tinted copy of the same one — so the row still reads with no colour at
	 * all. Specificity has to clear `.row--visited .state`: a read row dims its
	 * glyph, but a review someone is waiting on does not stop being your turn
	 * because you opened it once.
	 */
	.row .state--reason {
		position: relative;
		z-index: 1;
		color: var(--color-accent);
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

	/* ── Change size ────────────────────────────────────────────────────── */

	/*
	 * The rail, right-aligned, so the numbers terminate on the card's own right
	 * inset. Being the row's last column is what fixes that edge for free.
	 *
	 * The floor keeps a repo of one- and two-file PRs from collapsing the column
	 * to a hairline; the right edge itself needs no help.
	 */
	.size {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		/* Matches `.body`'s gap, so the two columns share one internal rhythm. */
		gap: 0.1875rem;
		flex-shrink: 0;
		min-width: 5rem;
		padding-left: 0.75rem;
	}

	/*
	 * Line-heights are absolute, not ratios, and that is the whole trick: the
	 * title's line box is 0.875rem x 1.4 = 1.225rem and the metadata's is
	 * 0.75rem x 1.4 = 1.05rem. Restating those two numbers here makes both
	 * columns' line boxes identical, so the file count sits on the title's
	 * baseline and the diffstat on the metadata's — at any font size, without
	 * a magic offset.
	 */
	.size-files {
		display: flex;
		align-items: baseline;
		gap: 0.25rem;
		line-height: 1.225rem;
		white-space: nowrap;
	}

	/* The digits are the datum; the unit is a label. Weight and ink split them
	   so the eye lands on the number, not on the word "files" repeated nine
	   times down the column. */
	.size-count {
		font-size: 0.8125rem;
		font-weight: 600;
		/* Without tabular figures the proportional `1` is narrow and the column
		   only *approximately* lines up, which is worse than not aligning. */
		font-variant-numeric: tabular-nums;
		color: var(--color-text-primary);
	}

	.row--visited .size-count {
		font-weight: 500;
		color: var(--color-text-secondary);
	}

	/*
	 * A fixed cell, and the text right-aligned *within* it, which is what makes
	 * both edges of this line behave at once: the count's right edge is
	 * (block − cell − gap) and so never moves, while the word still ends flush
	 * with the diffstat below it. Left-aligning inside the cell would hold the
	 * count but leave the word floating 6px shy of the column edge; sizing the
	 * cell to the text would hold the word but let a one-file PR shove the
	 * count sideways. The singular spends its slack on the gap instead, where
	 * nothing is trying to line up.
	 */
	.size-unit {
		/* Sized to "files" itself, not padded past it: any slack lands between
		   the count and the word, and a pair that reads as one phrase is worth
		   more than headroom the plural never uses. */
		min-width: 1.375rem;
		text-align: right;
		font-size: 0.6875rem;
		font-weight: 400;
		/* ink-secondary, not ink-muted — same reason as `.meta`. */
		color: var(--color-text-secondary);
	}

	/*
	 * The detail line. Mono and one step down from the count, which is the
	 * hierarchy the old inline version had backwards: the colours made the line
	 * counts louder than the file count they were supporting.
	 */
	.size-lines {
		display: flex;
		align-items: baseline;
		gap: 0.3125rem;
		line-height: 1.05rem;
		white-space: nowrap;
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		font-variant-numeric: tabular-nums;
		letter-spacing: 0.01em;
	}

	/*
	 * `+`/`−` carry the meaning; the colour is the redundant channel, not the
	 * only one. These are the system's *text* diff inks, measured for body copy,
	 * rather than the fill tints the diff gutters use.
	 */
	.add {
		color: var(--color-diff-add-text);
	}

	.del {
		color: var(--color-diff-del-text);
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
	 * Two things give way as the container narrows, in order of how little they
	 * cost. Both stay in the DOM (visually hidden) so screen-reader output is
	 * identical at every width.
	 *
	 * The branch goes first, because below ~460px it has nothing left to say — an
	 * ellipsed source plus a clipped target is worse than no branch at all. The
	 * reason is not on this list: a 15px glyph in a slot the row already had
	 * costs nothing to keep.
	 */
	@container tagged (max-width: 460px) {
		.branch {
			position: absolute;
			width: 1px;
			height: 1px;
			overflow: hidden;
			clip-path: inset(50%);
		}
	}

	/* Last to go, and only once the row is narrow enough that a column costs
	   the title more than the column is worth. `display: none` would be wrong:
	   clipped, the block keeps its spelled-out label in the accessibility tree,
	   so what a screen reader hears is identical at every width. */
	@container tagged (max-width: 400px) {
		.size {
			position: absolute;
			width: 1px;
			height: 1px;
			min-width: 0;
			padding: 0;
			overflow: hidden;
			clip-path: inset(50%);
			white-space: nowrap;
		}
	}
</style>
