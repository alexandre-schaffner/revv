<script lang="ts" module>
import type { Collapsible as CollapsiblePrimitive } from "bits-ui";

export type PlanTriggerProps = CollapsiblePrimitive.TriggerProps;
</script>

<script lang="ts">
	import { cn } from "$lib/utils.js";
	import { CollapsibleTrigger } from "$lib/components/ui/collapsible/index.js";
	import { Button } from "$lib/components/ui/button/index.js";
	import ChevronsUpDown from "phosphor-svelte/lib/ArrowsOutLineVertical";

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
	<Button variant="ghost" size="icon" class="size-8">
		<ChevronsUpDown class="size-4" />
		<span class="sr-only">Toggle plan details</span>
	</Button>
</CollapsibleTrigger>
