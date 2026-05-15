<script lang="ts" module>
	import type { Collapsible as CollapsiblePrimitive } from "bits-ui";

	export type ChainOfThoughtHeaderProps = CollapsiblePrimitive.TriggerProps;
</script>

<script lang="ts">
	import { cn } from "$lib/utils.js";
	import { CollapsibleTrigger } from "$lib/components/ui/collapsible/index.js";
	import { ChevronRight } from "@lucide/svelte";

	let {
		children,
		class: className,
		...restProps
	}: ChainOfThoughtHeaderProps = $props();
</script>

<CollapsibleTrigger
	data-slot="chain-of-thought-header"
	class={cn(
		"flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium text-muted-foreground transition-colors duration-snap hover:bg-muted",
		className,
	)}
	{...restProps}
>
	<ChevronRight class="size-3 shrink-0 transition-transform duration-snap [[data-state=open]_&]:rotate-90" />
	{#if children}
		{@render children?.()}
	{:else}
		Chain of Thought
	{/if}
</CollapsibleTrigger>
