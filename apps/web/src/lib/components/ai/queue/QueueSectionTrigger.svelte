<script lang="ts" module>
export type QueueSectionTriggerProps = {
  class?: string;
};
</script>

<script lang="ts">
	import type { Snippet } from "svelte";
	import { cn } from "$lib/utils.js";
	import { CollapsibleTrigger } from "$lib/components/ui/collapsible/index.js";

	let {
		children,
		class: className,
	}: QueueSectionTriggerProps & { children?: Snippet } = $props();
</script>

<CollapsibleTrigger
	data-slot="queue-section-trigger"
	class={cn(
		"group flex w-full items-center justify-between rounded-md bg-[var(--color-bg-tertiary)] px-3 py-2 text-left font-medium text-muted-foreground text-sm transition-colors duration-snap hover:bg-[var(--color-bg-tertiary)]/80",
		className,
	)}
>
	{@render children?.()}
</CollapsibleTrigger>
