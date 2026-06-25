<script lang="ts">
import FileCode from "phosphor-svelte/lib/FileCode";
import { gsapFadeY, tokens } from "$lib/motion";

interface Props {
  paths: readonly string[];
  activeIndex: number;
  onselect: (path: string) => void;
}

let { paths, activeIndex, onselect }: Props = $props();

function shortPath(path: string): string {
  if (path.length <= 58) return path;
  return `${path.slice(0, 24)}...${path.slice(-28)}`;
}
</script>

{#if paths.length > 0}
	<div
		class="absolute bottom-full left-3 right-3 z-20 mb-1 max-h-64 overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-md"
		in:gsapFadeY={{ y: 4, duration: tokens.quick }}
		out:gsapFadeY={{ y: 4, duration: tokens.snap }}
	>
		{#each paths as path, index (path)}
			<button
				type="button"
				class={[
					"flex w-full items-center gap-2 rounded px-2 py-1.5 text-left font-mono text-xs",
					index === activeIndex ? "bg-accent/10 text-accent" : "text-foreground hover:bg-muted",
				]}
				title={path}
				onclick={() => onselect(path)}
			>
				<FileCode class="size-3.5 shrink-0" />
				<span class="min-w-0 truncate">{shortPath(path)}</span>
			</button>
		{/each}
	</div>
{/if}
