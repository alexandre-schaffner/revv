<script lang="ts" module>
	import type { Collapsible as CollapsiblePrimitive } from "bits-ui";

	export type PlanTriggerProps = CollapsiblePrimitive.TriggerProps;
</script>

<script lang="ts">
	import { cn } from "$lib/utils.js";
	import { CollapsibleTrigger } from "$lib/components/ui/collapsible/index.js";
	import { Button } from "$lib/components/ui/button/index.js";
	import { ChevronDown } from "@lucide/svelte";

	let {
		children,
		class: className,
		...restProps
	}: PlanTriggerProps = $props();
</script>

<CollapsibleTrigger
	data-slot="plan-trigger"
	class={cn("", className)}
	{...restProps}
>
	<Button variant="ghost" size="icon-xs">
		<ChevronDown class="size-3.5 transition-transform duration-snap [[data-state=open]_&]:rotate-180" />
		<span class="sr-only">Toggle plan details</span>
	</Button>
</CollapsibleTrigger>
