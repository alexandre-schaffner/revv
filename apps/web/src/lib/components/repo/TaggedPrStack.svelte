<script lang="ts">
/*
 * A GitHub stack in the repo homepage's queue. Its PRs are cards, a pile of
 * sheets gathered where the highest-ranked one would sit, top of the stack
 * first, set in a little and hung off a hairline rail that runs down to the
 * branch they land on. The top card lies level with the rows around it; the
 * pile grows away from the reader, sunk into the page behind it.
 *
 * A tall stack folds to its top card with the rest showing as sheet edges
 * beneath it, since ten rows of one chain would bury everything else in the
 * queue; hovering it fans the sheets a little, pressing it deals the cards
 * out, and its foot folds it back. Dealt out, the members lie flat like any
 * other row, and only the indent and the rail group them.
 *
 * What each card says is `TaggedPrRowBody`'s; the card itself (its paper,
 * its place in the pile, its motion) is this component's.
 */

import CaretDown from "phosphor-svelte/lib/CaretDown";
import { tick } from "svelte";
import TaggedPrRowBody from "$lib/components/repo/TaggedPrRowBody.svelte";
import { flipStack, gsapFade, gsapHover, gsapPress, snapshotStack, tokens } from "$lib/motion";
import { STACK_FOLD_AT, type TaggedEntry } from "$lib/prs/tagged-prs";
import { getVisitState } from "$lib/stores/pr-visits.svelte";
import { getStackHeadline } from "$lib/stores/stack-headlines.svelte";

interface Props {
  stack: Extract<TaggedEntry, { kind: "stack" }>;
  /** DOM id for the card list, which the fold controls point at. */
  cardsId: string;
  /** Whether every card is dealt out. The queue keeps it, across re-renders. */
  open: boolean;
}

let { stack, cardsId, open = $bindable() }: Props = $props();

/** Sheet edges a folded stack shows under its top card; deeper ones hide behind the last. */
const SHEETS_SHOWN = 2;

const size = $derived(stack.members.length);
const collapsible = $derived(size >= STACK_FOLD_AT);
const visits = $derived(stack.members.map((m) => getVisitState(m.pr.id, m.pr.headSha)));
/** Folded-away members the reader already opened and the author has since pushed to. */
const hiddenMoved = $derived(open ? 0 : visits.slice(1).filter((v) => v === "moved").length);

/**
 * The feature the stack builds, once the server has named it. It can be
 * renamed a moment after first paint (a name read off the titles, then the
 * model's), so the name fades in when it changes rather than snapping.
 */
const named = $derived(getStackHeadline(stack.members[0].pr.repositoryId, stack.number));

/*
 * TEMPORARY dev toggle while two treatments are compared side by side:
 * `localStorage["revv.stackHeadlineVariant"]` is "foot" (the name leads the
 * foot's label) or "header" (a line above the top card). Delete the losing
 * variant and this switch together.
 */
const headlineVariant: "foot" | "header" = (() => {
  try {
    return localStorage.getItem("revv.stackHeadlineVariant") === "header" ? "header" : "foot";
  } catch {
    return "foot";
  }
})();
const nameInFoot = $derived(named !== null && headlineVariant === "foot");
const nameInHeader = $derived(named !== null && headlineVariant === "header");
/** Spelled out under the name in the foot only when the cards are dealt; folded it is the cover's tooltip. */
const gistInFoot = $derived(nameInFoot && open && named?.gist != null);
const stackLabel = $derived(
  named
    ? `${named.headline}: stack of ${size} pull requests onto ${stack.base}`
    : `Stack of ${size} pull requests onto ${stack.base}`,
);

let root = $state<HTMLElement>();
let cover = $state<HTMLButtonElement>();
// The foot is a `<div>` folded and a `<button>` unfolded; both bind here.
let foot = $state<HTMLElement>();
const cards: (HTMLElement | null)[] = [];
const faces: (HTMLElement | null)[] = [];

const present = (els: readonly (HTMLElement | null)[]): HTMLElement[] =>
  els.slice(0, size).filter((el): el is HTMLElement => el !== null);

/**
 * Fold or unfold. The layout is CSS keyed off `stack--folded`; this measures
 * it on both sides of the flip so `flipStack` can play the change, then hands
 * focus to whatever now stands where the control was: the top card after an
 * unfold (the cover that was focused is gone), the cover after a fold (so is
 * the handle).
 */
async function toggle(): Promise<void> {
  if (!root) return;
  const cardEls = present(cards);
  const faceEls = present(faces);
  const before = snapshotStack(root, foot ? [...cardEls, foot] : cardEls);

  open = !open;
  await tick();

  // `foot` is re-read: the one measured before the flip is gone. Its
  // position was all `before` needed.
  flipStack(root, cardEls, faceEls, foot ?? null, before, open);
  const next = open ? faceEls[0]?.querySelector("a") : cover;
  next?.focus({ preventScroll: true });
}
</script>

<li
	class="stack"
	class:stack--folded={!open}
	class:stack--headed={nameInHeader}
	class:stack--gist={gistInFoot}
	style:--sheets={open ? 0 : Math.min(size - 1, SHEETS_SHOWN)}
	aria-label={stackLabel}
	bind:this={root}
	use:gsapHover={{ prop: '--fan' }}
	use:gsapPress={{ scale: 0.995, disabled: open }}
>
	<!--
		Variant B: the stack's name on a line of its own above the top card, the
		rail rising to a node beside it so the line reads as what the cards hang
		from.
	-->
	{#if nameInHeader && named}
		<div class="stack-head">
			{#key named.headline}
				<span class="stack-head-name" in:gsapFade={{ duration: tokens.smooth }}>{named.headline}</span>
			{/key}
			<!-- Keyed without an `if` around it, so a gist that arrives with a rename fades in too. -->
			{#key named.gist}
				<span class="stack-head-gist" in:gsapFade={{ duration: tokens.smooth }}>{named.gist ?? ""}</span>
			{/key}
		</div>
	{/if}
	<ol class="stack-cards" id={cardsId}>
		{#each stack.members as member, depth (member.pr.id)}
			<li
				class="card card--{visits[depth]}"
				style:--depth={depth}
				inert={!open}
				bind:this={cards[depth]}
			>
				<div class="face" bind:this={faces[depth]}>
					<TaggedPrRowBody row={member} visit={visits[depth] ?? "unvisited"} showBranch={false} />
				</div>
			</li>
		{/each}
	</ol>
	<!--
		Folded, the stack is one object, and pressing it opens it, the way you'd
		spread a pile on a desk to see what's in it. A real button laid over the
		whole thing, cards and caption alike; the cards under it are inert until
		it opens.
	-->
	{#if !open}
		<button
			type="button"
			class="stack-cover"
			aria-expanded="false"
			aria-controls={cardsId}
			aria-label="Show all {size} pull requests in this stack"
			aria-describedby={named?.gist ? `${cardsId}-gist` : undefined}
			title={nameInFoot ? (named?.gist ?? undefined) : undefined}
			bind:this={cover}
			onclick={toggle}
		>
			{#if named?.gist}
				<span class="sr-only" id="{cardsId}-gist">{named.gist}</span>
			{/if}
		</button>
	{/if}
	<!--
		The foot is the stack's label and, once it can fold, its handle: the
		whole line, not a button on the end of it. It is where the rail ends, on
		a ring for the branch the stack merges into, and the chevron says which
		way a press goes.
	-->
	{#snippet caption()}
		{#if nameInFoot && named}
			<!--
				Variant A: the name leads the label; dealt out, its gist sits on a
				line under it. The first line keeps a fixed band, so the ring stays
				centred on it however the foot grows.
			-->
			<span class="stack-label">
				<span class="stack-line">
					{#key named.headline}
						<span class="stack-name" in:gsapFade={{ duration: tokens.smooth }}>{named.headline}</span>
					{/key}
					<span class="stack-caption stack-caption--led">
						{size} pull requests onto
						<code class="stack-base" title={stack.base}>{stack.base}</code>
					</span>
					{#if hiddenMoved > 0}
						<span class="stack-moved">
							{hiddenMoved} with new commits
						</span>
					{/if}
				</span>
				{#if open}
					{#key named.gist}
						<span class="stack-gist" in:gsapFade={{ duration: tokens.smooth }}>{named.gist ?? ""}</span>
					{/key}
				{/if}
			</span>
		{:else}
			<span class="stack-caption">
				{size} pull requests onto
				<code class="stack-base" title={stack.base}>{stack.base}</code>
			</span>
			{#if hiddenMoved > 0}
				<span class="stack-moved">
					{hiddenMoved} with new commits
				</span>
			{/if}
		{/if}
		{#if collapsible}
			<span class="stack-chevron" class:stack-chevron--open={open}>
				<CaretDown size={12} weight="bold" aria-hidden="true" />
			</span>
		{/if}
	{/snippet}
	{#if open && collapsible}
		<button
			type="button"
			class="stack-foot stack-foot--handle"
			aria-expanded="true"
			aria-controls={cardsId}
			aria-label="Fold the stack of {size} pull requests"
			bind:this={foot}
			onclick={toggle}
		>
			{@render caption()}
		</button>
	{:else}
		<div class="stack-foot" bind:this={foot}>
			{@render caption()}
		</div>
	{/if}
</li>

<style>
	/*
	 * Rows sit at the page's level, and so does a stack's top card: it takes
	 * a row's hairline like any other entry and lines up with the rows
	 * around it. The rest of a folded pile is what leaves that level, down
	 * and away behind it.
	 */
	.stack {
		/* 0–1: how folded the pile is, 1 folded and 0 dealt out. The fold
		   eases it in between; the lower cards' elbows key off it. */
		--elev: 0;
		/* How far each sheet drops below, and draws in from, the one above. */
		--sheet-drop: 0.5rem;
		--sheet-inset: 0.75rem;
		/* 0–1, eased by `gsapHover`: a folded stack under the pointer (or
		   holding focus) fans its sheets out a little, a preview of what is
		   underneath and a hint that it opens. */
		--fan: 0;
		/* The rail the cards hang off, like the trunk of a file tree: a
		   hairline in a gutter of its own, never drawn across a card. A step
		   firmer than the border so it reads at 1px, and opaque, since the rail
		   and each elbow overlap where they meet. */
		--gutter: 1.75rem;
		--rail-x: 0.6875rem;
		--stack-rail: color-mix(in srgb, var(--color-text-muted) 40%, var(--color-border));
		/* The geometry the rail is drawn from. `--glyph-y` is where a card's
		   leading glyph has its middle, down from the card's padding box (its
		   padding plus half the glyph's line box); the elbow turns into the
		   card there. The rail runs from the first elbow to the middle of the
		   ring on the foot, `--ring-y` down a foot `--foot-h` tall. */
		--stack-pad-top: 0rem;
		--elbow-top: 0.8125rem;
		--glyph-y: 21px;
		--foot-h: 2.25rem;
		--ring-y: 1.125rem;
		--ring-r: 3.5px;
		position: relative;
		padding-top: var(--stack-pad-top);
		padding-left: var(--gutter);
		border-top: 1px solid var(--color-border-subtle);
	}

	.stack:first-child {
		border-top: none;
	}

	.stack--folded {
		--elev: 1;
	}

	/* From the first card's elbow down to the ring on the foot. Sized off the
	   stack's own box, so it grows and shrinks with a fold for free. */
	.stack::before {
		content: "";
		position: absolute;
		left: var(--rail-x);
		top: calc(var(--stack-pad-top) + 1px + var(--elbow-top));
		bottom: calc(var(--foot-h) - var(--ring-y) + var(--ring-r));
		width: 1px;
		background: var(--stack-rail);
	}

	/* Covers the folded stack, foot included, so the whole pile is the
	   target. Above the cards' own stacking (see `.card`). */
	.stack-cover {
		position: absolute;
		inset: 0;
		z-index: 30;
		padding: 0;
		border: none;
		background: transparent;
		cursor: pointer;
	}

	.stack-cover:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: -2px;
	}

	.stack-cards {
		position: relative;
		display: flex;
		flex-direction: column;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	/* ── Cards ──────────────────────────────────────────────────────────── */

	/*
	 * A PR in a stack, drawn the way a flat row is: square, on the page's
	 * own paper, edged only by a hairline. Where it sits is what says it
	 * belongs to a pile.
	 *
	 * Tints are mixed into the paper rather than laid over it: a translucent
	 * card would show the sheets beneath it through.
	 *
	 * `position: relative` anchors the body's stretched link.
	 */
	.card {
		position: relative;
		/* Top card always above the rest, folded or not, so the others travel
		   under it rather than over it. */
		z-index: calc(20 - var(--depth));
		display: flex;
		align-items: flex-start;
		/* A flat row's inset less the border, so a card's title sits on the
		   same column as a flat row's. */
		padding: calc(var(--spacing-inset) - 1px);
		border: 1px solid transparent;
		border-top-color: var(--color-border-subtle);
		background: var(--color-bg-primary);
		transition: background var(--duration-instant) var(--ease-soft);
	}

	/* Its hairline would double the stack's own. */
	.card:first-child {
		border-top-color: transparent;
	}


	/* Read, then pushed to: the flat row's teal, mixed into the paper. */
	.card--moved {
		background: color-mix(in srgb, var(--color-accent) 6%, var(--color-bg-primary));
	}

	/* A member answers the pointer like a flat row. Folded, the top card
	   answers it through the cover laid over the pile. */
	.stack:not(.stack--folded) .card:hover,
	.stack--folded:has(.stack-cover:hover) .card:first-child {
		background: color-mix(in srgb, var(--color-text-muted) 6%, var(--color-bg-primary));
	}

	.stack:not(.stack--folded) .card--moved:hover,
	.stack--folded:has(.stack-cover:hover) .card--moved:first-child {
		background: color-mix(in srgb, var(--color-accent) 10%, var(--color-bg-primary));
	}

	/* The link inside is the focus target; the ring goes round the card. */
	.card:has(:global(:focus-visible)) {
		outline: 2px solid var(--color-accent);
		outline-offset: 1px;
	}

	/* What the card says. Its own box, so a folded sheet can go blank and the
	   fold can fade it back in. */
	.face {
		display: flex;
		flex: 1 1 auto;
		min-width: 0;
	}

	/*
	 * Each card's elbow: down the rail and round into the card at its glyph,
	 * the way a tree draws a child. Sheets in a folded pile show none (below);
	 * only the top card hangs off the rail until the pile is dealt.
	 */
	.card::before {
		content: "";
		position: absolute;
		left: calc(var(--rail-x) - var(--gutter) - 1px);
		top: var(--elbow-top);
		/* To the card's outer edge, so the elbow meets its border rather
		   than drawing over it. */
		width: calc(var(--gutter) - var(--rail-x));
		height: calc(var(--glyph-y) - var(--elbow-top) + 1px);
		box-sizing: border-box;
		border-left: 1px solid var(--stack-rail);
		border-bottom: 1px solid var(--stack-rail);
		border-bottom-left-radius: 6px;
		pointer-events: none;
	}

	/* The lower cards' elbows come with the flattening: they would ride
	   along with each card as it is dealt (and scale with it), so they
	   appear only as the cards settle onto the rail, and go first when the
	   pile is gathered. Folded, `--elev` is 1 and they are gone. */
	.card:not(:first-child)::before {
		/* Over the second half only (opacity clamps below 0): by then the
		   card is nearly home, so the elbow arrives where it will stay. */
		opacity: calc(1 - var(--elev) * 2);
	}

	/* ── Folded ─────────────────────────────────────────────────────────── */

	/*
	 * Every card but the top one leaves the flow and lies behind it, each
	 * sheet a little lower and a little narrower, so only its bottom edge
	 * shows. The pile grows away from the reader, into the page: the top
	 * card is level with the rows around it and the sheets sit beneath that
	 * level. Each is drawn as nothing but a row's hairline along its foot,
	 * the one edge of it that shows, fainter the deeper it sits: the queue's
	 * own separator, repeated and drawn in. The faces go blank, since what peeks out of a real stack is
	 * paper, not a sliver of someone's title. Deeper than two, sheets wait
	 * invisibly behind the second, ready to be dealt.
	 */
	.stack--folded .stack-cards {
		padding-bottom: calc(var(--sheets) * var(--sheet-drop));
	}

	.stack--folded .card:not(:first-child) {
		position: absolute;
		top: calc(min(var(--depth), 2) * var(--sheet-drop));
		left: calc(min(var(--depth), 2) * var(--sheet-inset));
		right: calc(min(var(--depth), 2) * var(--sheet-inset));
		/* Plain paper, even under a card tinted for new commits: a teal
		   sliver would read as a state of its own. */
		border-color: transparent;
		border-bottom-color: var(--color-border-subtle);
		background: var(--color-bg-primary);
		/* Fanning spends the room the foot keeps above its line, so the
		   stack's height, and every row below it, stays put. On `translate`,
		   so it never lays anything out. */
		translate: 0 calc(min(var(--depth), 2) * var(--fan) * 0.1875rem);
	}

	/* The sheet nearest the top card takes the firmer line. */
	.stack--folded .card:nth-child(2) {
		border-bottom-color: var(--color-border);
	}

	.stack--folded .card:nth-child(n + 4) {
		opacity: 0;
	}

	.stack--folded .card:not(:first-child) > * {
		opacity: 0;
	}

	/* ── Foot ───────────────────────────────────────────────────────────── */

	/*
	 * A ring on the rail for the base branch, the caption on the cards' text
	 * column, and (once it folds) a chevron at the end.
	 */
	.stack-foot {
		position: relative;
		z-index: 25;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		min-height: var(--foot-h);
		margin: 0;
		padding: 0.375rem var(--spacing-inset) 0.375rem calc(var(--spacing-inset) + 1.4375rem);
		border: none;
		background: transparent;
		font: inherit;
		font-size: 0.75rem;
		color: var(--color-text-secondary);
		text-align: left;
	}

	/* The foot sits inside the stack's gutter, so the ring reaches back out
	   to the rail, centred on it. */
	.stack-foot::after {
		content: "";
		position: absolute;
		top: calc(var(--ring-y) - var(--ring-r));
		left: calc(var(--rail-x) + 0.5px - var(--gutter) - var(--ring-r));
		width: calc(var(--ring-r) * 2);
		height: calc(var(--ring-r) * 2);
		box-sizing: border-box;
		border: 1px solid var(--stack-rail);
		border-radius: 50%;
		background: var(--color-bg-primary);
	}

	.stack-foot--handle {
		cursor: pointer;
	}

	.stack-foot--handle:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: -2px;
	}

	.stack-caption {
		display: flex;
		align-items: baseline;
		gap: 0.3125rem;
		min-width: 0;
		white-space: nowrap;
	}

	.stack-base {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		color: var(--color-text-primary);
	}

	/* The loudest thing a folded stack can hide, so it says so, in the same
	   teal and weight the row's own "New commits" clause uses. */
	.stack-moved {
		flex-shrink: 0;
		font-weight: 600;
		color: var(--color-accent);
	}

	.stack-moved::before {
		content: "\00b7" / "";
		margin-right: 0.5rem;
		font-weight: 400;
		color: var(--color-text-secondary);
		opacity: 0.5;
	}

	/* No label: the line says what the stack is, the chevron says which way
	   a press goes. It sits on the diffstat column. It turns without easing:
	   the foot it sits in is a different element folded and unfolded, so
	   there is no "before" for a transition to start from. */
	.stack-chevron {
		display: inline-flex;
		flex-shrink: 0;
		margin-left: auto;
		color: var(--color-text-muted);
		transition: color var(--duration-instant) var(--ease-soft);
	}

	.stack-chevron--open {
		transform: rotate(180deg);
	}

	/* The handle answers the pointer the way a flat row does, folded (via
	   the cover laid over it) or not. */
	.stack-foot--handle:hover,
	.stack-cover:hover ~ .stack-foot {
		color: var(--color-text-primary);
	}

	.stack-foot--handle:hover .stack-chevron,
	.stack-cover:hover ~ .stack-foot .stack-chevron {
		color: var(--color-text-primary);
	}

	/* ── The feature's name ─────────────────────────────────────────────── */

	/*
	 * Variant A: the foot's label leads with the name, a step up from the
	 * caption in size and ink, then "· 4 pull requests onto main" as before.
	 * The first line is a band `--foot-h` tall less the foot's padding, on
	 * a 1.5rem line, so the ring's `--ring-y` still lands on its middle;
	 * dealt out, the gist adds a line under it and `--foot-h` grows by just
	 * that much, which carries the rail's end and the ring along.
	 */
	.stack--gist {
		--foot-h: 3.375rem;
	}

	.stack--gist .stack-foot {
		align-items: flex-start;
	}

	.stack--gist .stack-chevron {
		align-items: center;
		height: 1.5rem;
	}

	.stack-label {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.stack-line {
		display: flex;
		align-items: baseline;
		gap: 0.3125rem;
		min-width: 0;
		height: 1.5rem;
		line-height: 1.5rem;
		white-space: nowrap;
	}

	/* The name gives way before the branch does: the base is what the
	   caption is for. */
	.stack-name {
		flex: 0 1 auto;
		min-width: 4rem;
		overflow: hidden;
		text-overflow: ellipsis;
		font-size: 0.8125rem;
		font-weight: 500;
		letter-spacing: -0.005em;
		color: var(--color-text-primary);
	}

	.stack-line .stack-caption {
		flex-shrink: 0;
	}

	.stack-caption--led::before {
		content: "\00b7" / "";
		margin-right: 0.0625rem;
		opacity: 0.5;
	}

	/* `--color-text-subtle`, not muted: it is read, not decoration. */
	.stack-gist {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 0.75rem;
		line-height: 1rem;
		color: var(--color-text-subtle);
	}

	.stack-gist:empty {
		display: none;
	}

	/*
	 * Variant B: a line above the top card, on the cards' text column. The
	 * rail starts at a solid node beside it, the stack's tip, and runs down
	 * to the hollow ring at its base, so the line reads as what the cards
	 * hang from.
	 */
	.stack--headed {
		--head-h: 1.75rem;
		--head-y: 1.25rem;
		--node-r: 2.5px;
	}

	.stack--headed::before {
		top: calc(var(--stack-pad-top) + var(--head-y));
	}

	.stack-head {
		position: relative;
		z-index: 25;
		display: flex;
		align-items: baseline;
		gap: 0.625rem;
		min-width: 0;
		height: var(--head-h);
		padding: 0.625rem var(--spacing-inset) 0 calc(var(--spacing-inset) + 1.4375rem);
		line-height: 1.125rem;
		white-space: nowrap;
	}

	.stack-head::after {
		content: "";
		position: absolute;
		top: calc(var(--head-y) - var(--node-r));
		left: calc(var(--rail-x) + 0.5px - var(--gutter) - var(--node-r));
		width: calc(var(--node-r) * 2);
		height: calc(var(--node-r) * 2);
		border-radius: 50%;
		background: var(--stack-rail);
	}

	/* The name keeps its room; the gist takes what is left. */
	.stack-head-name {
		flex: 0 0 auto;
		max-width: 70%;
		overflow: hidden;
		text-overflow: ellipsis;
		font-size: 0.8125rem;
		font-weight: 500;
		letter-spacing: -0.005em;
		color: var(--color-text-primary);
	}

	.stack-head-gist {
		flex: 1 1 0;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		font-size: 0.75rem;
		color: var(--color-text-subtle);
	}
</style>
