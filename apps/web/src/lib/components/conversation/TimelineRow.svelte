<script lang="ts">
import type { Snippet } from "svelte";

// One entry on the timeline rail: a round glyph on the rail, the line beside
// it, and an optional body under the line. Columns come from Timeline's
// `--rail-glyph` / `--rail-gap`, so every row's text starts at the same x.

interface Props {
  /** The rail glyph; without one, the row only keeps its text column. */
  glyph?: Snippet;
  /** A state change GitHub draws filled and coloured. */
  tone?: "merged" | "closed" | "open" | null;
  actions?: Snippet;
  /** Under the line, in the text column. */
  body?: Snippet;
  children: Snippet;
}

let { glyph, tone = null, actions, body, children }: Props = $props();
</script>

<li class="row">
	{#if glyph}
		<span class="glyph glyph--{tone ?? 'plain'}" aria-hidden="true">{@render glyph()}</span>
	{/if}
	<div class="line">{@render children()}</div>
	{#if actions}<div class="actions">{@render actions()}</div>{/if}
	{#if body}<div class="body">{@render body()}</div>{/if}
</li>

<style>
	.row {
		display: grid;
		grid-template-columns: var(--rail-glyph) minmax(0, 1fr) auto;
		align-items: start;
		padding: 5px 0;
	}

	/* Gaps are margins, not column-gap, so an absent column costs no space. */
	.line,
	.actions,
	.body {
		min-width: 0;
		margin-left: var(--rail-gap);
	}

	.line {
		grid-column: 2;
	}

	.actions {
		grid-column: 3;
	}

	.body {
		grid-column: 2 / -1;
	}

	/* A snippet that rendered nothing. */
	.actions:empty,
	.body:empty {
		display: none;
	}

	.glyph {
		position: relative;
		z-index: 1;
		display: grid;
		place-items: center;
		grid-column: 1;
		width: var(--rail-glyph);
		height: var(--rail-glyph);
		border-radius: 50%;
		background: var(--color-bg-secondary);
		box-shadow: 0 0 0 3px var(--color-bg-primary);
		color: var(--color-text-secondary);
	}

	.glyph--merged {
		background: var(--color-merged);
		color: var(--color-bg-primary);
	}

	.glyph--closed {
		background: var(--color-danger);
		color: var(--color-bg-primary);
	}

	.glyph--open {
		background: var(--color-success);
		color: var(--color-bg-primary);
	}
</style>
