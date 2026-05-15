<script lang="ts" module>
import type { Collapsible as CollapsiblePrimitive } from "bits-ui";

export type QueueSectionProps = CollapsiblePrimitive.RootProps;
</script>

<script lang="ts">
	import { cn } from "$lib/utils.js";
	import { Collapsible } from "$lib/components/ui/collapsible/index.js";

	let {
		open = $bindable(true),
		children,
		class: className,
		...restProps
	}: QueueSectionProps = $props();
</script>

<Collapsible
	data-slot="queue-section"
	class={cn("", className)}
	bind:open
	{...restProps}
>
	{@render children?.()}
</Collapsible>
