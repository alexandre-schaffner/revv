<script lang="ts">
import Command from "phosphor-svelte/lib/Command";
import { gsapFadeY, tokens } from "$lib/motion";

interface Item {
  readonly name: string;
  readonly description: string;
}

interface Props {
  items: readonly Item[];
  activeIndex: number;
  onselect: (item: Item) => void;
}

let { items, activeIndex, onselect }: Props = $props();
</script>

{#if items.length > 0}
	<div
		class="absolute bottom-full left-3 right-3 z-20 mb-1 overflow-hidden rounded-md border border-border bg-popover p-1 shadow-md"
		in:gsapFadeY={{ y: 4, duration: tokens.quick }}
		out:gsapFadeY={{ y: 4, duration: tokens.snap }}
	>
		{#each items as item, index (item.name)}
			<button
				type="button"
				class={[
					"flex w-full items-start gap-2 rounded px-2 py-1.5 text-left text-sm",
					index === activeIndex ? "bg-accent/10 text-accent" : "text-foreground hover:bg-muted",
				]}
				onclick={() => onselect(item)}
			>
				<Command class="mt-0.5 size-3.5 shrink-0" />
				<span class="min-w-0">
					<span class="block font-mono text-xs">/{item.name}</span>
					<span class="block truncate text-xs text-muted-foreground">{item.description}</span>
				</span>
			</button>
		{/each}
	</div>
{/if}
