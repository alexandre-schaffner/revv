<script lang="ts" generics="T extends { readonly number: number }">
import type { Snippet } from "svelte";

// A stack drawn the way GitHub draws it: top layer first, the base branch
// last, every layer hung on one spine that ends in the base's ring. Rows are
// the caller's; a row marks its glyph with `stack-layer-glyph` so the glyph
// sits on the spine. `--stack-layer-gap` spaces the rows and
// `--stack-spine-bottom` sets where the spine stops above the list's foot.

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
		<span class="stack-layer-glyph base-ring" aria-hidden="true"></span>
		<code>{baseRefName}</code>
	</li>
</ol>

<style>
	.stack-layer-list {
		position: relative;
		display: flex;
		flex-direction: column;
		gap: var(--stack-layer-gap, 0);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	/* The spine the layers hang on, base at the bottom. */
	.stack-layer-list::before {
		content: "";
		position: absolute;
		top: 16px;
		bottom: var(--stack-spine-bottom, 12px);
		left: 14.5px;
		width: 1px;
		background: var(--color-border);
	}

	.stack-layer-list :global(.stack-layer-glyph) {
		position: relative;
		z-index: 1;
		display: grid;
		place-items: center;
		flex-shrink: 0;
		width: 14px;
		height: 18px;
		background: var(--color-bg-primary);
		border-radius: 50%;
	}

	.base {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 8px;
	}

	.stack-layer-list .base-ring {
		width: 9px;
		height: 9px;
		margin: 0 2.5px;
		border: 1.5px solid var(--color-text-muted);
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
