<script lang="ts" module>
import type { Collapsible as CollapsiblePrimitive } from "bits-ui";

export type PlanContentProps = CollapsiblePrimitive.ContentProps;
</script>

<script lang="ts">
	import { cn } from "$lib/utils.js";
	import { CollapsibleContent } from "$lib/components/ui/collapsible/index.js";

	let {
		children,
		class: className,
		...restProps
	}: PlanContentProps = $props();
</script>

<CollapsibleContent
	data-slot="plan-content"
	class={cn("px-4 pb-3", className)}
	{...restProps}
>
	{@render children?.()}
</CollapsibleContent>
