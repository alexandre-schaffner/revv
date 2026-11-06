<script lang="ts" generics="T extends { readonly number: number }">
import type { Snippet } from "svelte";
import SpineGlyph from "./SpineGlyph.svelte";

// A stack drawn top-first down a spine to its base branch. Each row insets its
// content by `--stack-row-inset` and puts a SpineGlyph first, so the glyphs sit
// on the spine.

interface Props {
  /** Top of the stack first. */
  layers: readonly T[];
  baseRefName: string;
  row: Snippet<[T]>;
  role?: "list" | "radiogroup";
  "aria-label"?: string;
}

let { layers, baseRefName, row, role, "aria-label": ariaLabel }: Props = $props();
</script>

<ol class="stack-layer-list" {role} aria-label={ariaLabel}>
	{#each layers as layer (layer.number)}
		<li>{@render row(layer)}</li>
	{/each}
	<li class="base">
		<SpineGlyph ring />
		<code>{baseRefName}</code>
	</li>
</ol>

<style>
	.stack-layer-list {
		--stack-row-inset: 8px;
		position: relative;
		display: flex;
		flex-direction: column;
		gap: var(--stack-layer-gap, 0);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.stack-layer-list::before {
		content: "";
		position: absolute;
		top: 16px;
		bottom: var(--stack-spine-bottom, 12px);
		/* The centre of a 14px glyph after the row inset. */
		left: calc(var(--stack-row-inset) + 6.5px);
		width: 1px;
		background: var(--color-border);
	}

	.base {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px var(--stack-row-inset);
	}

	code {
		padding: 1px 6px;
		border-radius: 4px;
		background: var(--color-bg-tertiary);
		font-family: var(--font-mono);
		font-size: 0.75rem;
		color: var(--color-text-secondary);
	}
</style>
