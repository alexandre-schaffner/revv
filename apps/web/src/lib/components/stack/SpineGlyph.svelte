<script lang="ts">
import type { Snippet } from "svelte";

// A row's glyph on StackLayerList's spine: a slot that knocks the spine out
// behind it. A row whose background changes (hover, current) sets
// `--spine-knockout` to match, or `transparent` to let the spine show.

interface Props {
  children?: Snippet;
  /** The base branch's hollow ring instead of a glyph. */
  ring?: boolean;
}

let { children, ring = false }: Props = $props();
</script>

<span class="spine-glyph" class:spine-glyph--ring={ring} aria-hidden="true">{@render children?.()}</span>

<style>
	.spine-glyph {
		position: relative;
		z-index: 1;
		display: grid;
		place-items: center;
		flex-shrink: 0;
		width: 14px;
		height: 18px;
		background: var(--spine-knockout, var(--color-bg-primary));
		border-radius: 50%;
	}

	.spine-glyph--ring {
		width: 9px;
		height: 9px;
		margin: 0 2.5px;
		border: 1.5px solid var(--color-text-muted);
	}
</style>
