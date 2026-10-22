<script lang="ts">
import CaretDown from "phosphor-svelte/lib/CaretDown";
import { tick } from "svelte";
import TaggedPrRowBody from "$lib/components/repo/TaggedPrRowBody.svelte";
import { flipStack, gsapHover, gsapPress, snapshotStack } from "$lib/motion";
import { STACK_FOLD_AT, type TaggedEntry } from "$lib/prs/tagged-prs";
import { getVisitState } from "$lib/stores/pr-visits.svelte";

interface Props {
  stack: Extract<TaggedEntry, { kind: "stack" }>;
  cardsId: string;
  open: boolean;
}

let { stack, cardsId, open = $bindable() }: Props = $props();

const SHEETS_SHOWN = 2;

const size = $derived(stack.members.length);
const collapsible = $derived(size >= STACK_FOLD_AT);
const visits = $derived(stack.members.map((m) => getVisitState(m.pr.id, m.pr.headSha)));
const hiddenMoved = $derived(open ? 0 : visits.slice(1).filter((v) => v === "moved").length);

let root = $state<HTMLElement>();
let cover = $state<HTMLButtonElement>();
let foot = $state<HTMLElement>();
const cards: (HTMLElement | null)[] = [];
const faces: (HTMLElement | null)[] = [];

const present = (els: readonly (HTMLElement | null)[]): HTMLElement[] =>
  els.slice(0, size).filter((el): el is HTMLElement => el !== null);

async function toggle(): Promise<void> {
  if (!root || !foot) return;
  const cardEls = present(cards);
  const faceEls = present(faces);
  const before = snapshotStack(root, [...cardEls, foot]);

  open = !open;
  await tick();

  flipStack(root, cardEls, faceEls, foot, before, open);
  const next = open ? faceEls[0]?.querySelector("a") : cover;
  next?.focus({ preventScroll: true });
}
</script>

<li
	class="stack"
	class:stack--folded={!open}
	style:--sheets={open ? 0 : Math.min(size - 1, SHEETS_SHOWN)}
	aria-label="Stack of {size} pull requests onto {stack.base}"
	bind:this={root}
	use:gsapHover={{ prop: '--fan' }}
	use:gsapPress={{ scale: 0.995, disabled: open }}
>
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
	{#if !open}
		<button
			type="button"
			class="stack-cover"
			aria-expanded="false"
			aria-controls={cardsId}
			aria-label="Show all {size} pull requests in this stack"
			bind:this={cover}
			onclick={toggle}
		></button>
	{/if}
	<div class="stack-foot" bind:this={foot}>
		<span class="stack-caption">
			{size} pull requests onto
			<code class="stack-base" title={stack.base}>{stack.base}</code>
		</span>
		{#if hiddenMoved > 0}
			<span class="stack-moved">
				{hiddenMoved} with new commits
			</span>
		{/if}
		{#if collapsible}
			<span class="stack-chevron">
				<CaretDown size={12} weight="bold" aria-hidden="true" />
			</span>
		{/if}
		{#if open && collapsible}
			<button
				type="button"
				class="stack-fold"
				aria-expanded="true"
				aria-controls={cardsId}
				aria-label="Fold the stack of {size} pull requests"
				onclick={toggle}
			></button>
		{/if}
	</div>
</li>

<style>
	.stack {
		--elev: 0;
		--sheet-drop: 0.5rem;
		--sheet-inset: 0.75rem;
		--fan: 0;
		--gutter: 1.75rem;
		--rail-x: 0.6875rem;
		--stack-rail: color-mix(in srgb, var(--color-text-muted) 40%, var(--color-border));
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

	.stack::before {
		content: "";
		position: absolute;
		left: var(--rail-x);
		top: calc(var(--stack-pad-top) + 1px + var(--elbow-top));
		bottom: calc(var(--foot-h) - var(--ring-y) + var(--ring-r));
		width: 1px;
		background: var(--stack-rail);
	}

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

	.card {
		position: relative;
		z-index: calc(20 - var(--depth));
		display: flex;
		align-items: flex-start;
		padding: calc(var(--spacing-inset) - 1px);
		border: 1px solid transparent;
		border-top-color: var(--color-border-subtle);
		background: var(--color-bg-primary);
		transition: background var(--duration-instant) var(--ease-soft);
	}

	.card:first-child {
		border-top-color: transparent;
	}


	.card--moved {
		background: color-mix(in srgb, var(--color-accent) 6%, var(--color-bg-primary));
	}

	.stack:not(.stack--folded) .card:hover,
	.stack--folded:has(.stack-cover:hover) .card:first-child {
		background: color-mix(in srgb, var(--color-text-muted) 6%, var(--color-bg-primary));
	}

	.stack:not(.stack--folded) .card--moved:hover,
	.stack--folded:has(.stack-cover:hover) .card--moved:first-child {
		background: color-mix(in srgb, var(--color-accent) 10%, var(--color-bg-primary));
	}

	.card:has(:global(:focus-visible)) {
		outline: 2px solid var(--color-accent);
		outline-offset: 1px;
	}

	.face {
		display: flex;
		flex: 1 1 auto;
		min-width: 0;
	}

	.card::before {
		content: "";
		position: absolute;
		left: calc(var(--rail-x) - var(--gutter) - 1px);
		top: var(--elbow-top);
		width: calc(var(--gutter) - var(--rail-x));
		height: calc(var(--glyph-y) - var(--elbow-top) + 1px);
		box-sizing: border-box;
		border-left: 1px solid var(--stack-rail);
		border-bottom: 1px solid var(--stack-rail);
		border-bottom-left-radius: 6px;
		pointer-events: none;
	}

	.card:not(:first-child)::before {
		opacity: calc(1 - var(--elev) * 2);
	}

	.stack--folded .stack-cards {
		padding-bottom: calc(var(--sheets) * var(--sheet-drop));
	}

	.stack--folded .card:not(:first-child) {
		position: absolute;
		top: calc(min(var(--depth), 2) * var(--sheet-drop));
		left: calc(min(var(--depth), 2) * var(--sheet-inset));
		right: calc(min(var(--depth), 2) * var(--sheet-inset));
		border-color: transparent;
		border-bottom-color: var(--color-border-subtle);
		background: var(--color-bg-primary);
		translate: 0 calc(min(var(--depth), 2) * var(--fan) * 0.1875rem);
	}

	.stack--folded .card:nth-child(2) {
		border-bottom-color: var(--color-border);
	}

	.stack--folded .card:nth-child(n + 4) {
		opacity: 0;
	}

	.stack--folded .card:not(:first-child) > * {
		opacity: 0;
	}

	.stack-foot {
		position: relative;
		z-index: 25;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-height: var(--foot-h);
		padding: 0.375rem var(--spacing-inset) 0.375rem calc(var(--spacing-inset) + 1.4375rem);
		font-size: 0.75rem;
		color: var(--color-text-secondary);
	}

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

	.stack-fold {
		position: absolute;
		inset: 0;
		padding: 0;
		border: none;
		background: transparent;
		cursor: pointer;
	}

	.stack-fold:focus-visible {
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

	.stack-chevron {
		display: inline-flex;
		flex-shrink: 0;
		margin-left: auto;
		color: var(--color-text-muted);
		rotate: calc((1 - var(--elev)) * 180deg);
		transition: color var(--duration-instant) var(--ease-soft);
	}

	.stack-foot:has(.stack-fold:hover),
	.stack-cover:hover ~ .stack-foot {
		color: var(--color-text-primary);
	}

	.stack-foot:has(.stack-fold:hover) .stack-chevron,
	.stack-cover:hover ~ .stack-foot .stack-chevron {
		color: var(--color-text-primary);
	}
</style>
