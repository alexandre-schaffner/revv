<script lang="ts" module>
	import type { Collapsible as CollapsiblePrimitive } from "bits-ui";

	export type TaskTriggerProps = CollapsiblePrimitive.TriggerProps & {
		/** The title of the task. */
		title: string;
	};
</script>

<script lang="ts">
	import { cn } from "$lib/utils.js";
	import { CollapsibleTrigger } from "$lib/components/ui/collapsible/index.js";
	import { ChevronRight } from "@lucide/svelte";

	let {
		title,
		children,
		class: className,
		...restProps
	}: TaskTriggerProps = $props();
</script>

<CollapsibleTrigger
	data-slot="task-trigger"
	class={cn(
		"flex w-full items-center gap-2 px-3 py-2.5 text-sm font-medium text-foreground transition-colors duration-snap hover:bg-muted/50",
		className,
	)}
	{...restProps}
>
	<ChevronRight class="size-3.5 shrink-0 text-muted-foreground transition-transform duration-snap [[data-state=open]_&]:rotate-90" />
	<span class="flex-1 text-left">{title}</span>
	{@render children?.()}
</CollapsibleTrigger>
