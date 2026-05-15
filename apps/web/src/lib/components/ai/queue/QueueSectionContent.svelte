<script lang="ts" module>
	import type { Collapsible as CollapsiblePrimitive } from "bits-ui";

	export type QueueSectionContentProps = CollapsiblePrimitive.ContentProps;
</script>

<script lang="ts">
	import { cn } from "$lib/utils.js";
	import { CollapsibleContent } from "$lib/components/ui/collapsible/index.js";

	let {
		children,
		class: className,
		...restProps
	}: QueueSectionContentProps = $props();
</script>

<CollapsibleContent
	data-slot="queue-section-content"
	class={cn("", className)}
	{...restProps}
>
	{@render children?.()}
</CollapsibleContent>
