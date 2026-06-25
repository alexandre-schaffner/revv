<script lang="ts" generics="T">
import type { Snippet } from "svelte";
import { gsapFadeY, tokens } from "$lib/motion";

interface Props {
  items: readonly T[];
  activeIndex: number;
  /** Stable per-row key. */
  key: (item: T) => string;
  onselect: (item: T) => void;
  /** Renders the row body; receives the item and whether it is the active row. */
  row: Snippet<[T, boolean]>;
  /** Extra classes for the row `<button>` (e.g. layout / font per menu kind). */
  rowClass?: string;
  /** Optional per-row `title` (tooltip). */
  rowTitle?: (item: T) => string | undefined;
}

let { items, activeIndex, key, onselect, row, rowClass = "", rowTitle }: Props = $props();

// Keep the active row scrolled into view as the user arrows through it.
let buttons: (HTMLButtonElement | undefined)[] = $state([]);
$effect(() => {
  buttons[activeIndex]?.scrollIntoView({ block: "nearest" });
});
</script>

{#if items.length > 0}
	<div
		class="absolute bottom-full left-3 right-3 z-20 mb-1 max-h-64 overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-md"
		in:gsapFadeY={{ y: 4, duration: tokens.quick }}
		out:gsapFadeY={{ y: 4, duration: tokens.snap }}
	>
		{#each items as item, index (key(item))}
			<button
				bind:this={buttons[index]}
				type="button"
				class={[
					"w-full rounded px-2 py-1.5 text-left",
					rowClass,
					index === activeIndex ? "bg-accent/10 text-accent" : "text-foreground hover:bg-muted",
				]}
				title={rowTitle?.(item)}
				onclick={() => onselect(item)}
			>
				{@render row(item, index === activeIndex)}
			</button>
		{/each}
	</div>
{/if}
