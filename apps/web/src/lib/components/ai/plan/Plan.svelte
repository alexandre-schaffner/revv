<script lang="ts" module>
import type { Collapsible as CollapsiblePrimitive } from "bits-ui";

export type PlanProps = CollapsiblePrimitive.RootProps;
</script>

<script lang="ts">
	import { cn } from "$lib/utils.js";
	import { Collapsible } from "$lib/components/ui/collapsible/index.js";

	let {
		open = $bindable(true),
		children,
		class: className,
		...restProps
	}: PlanProps = $props();
</script>

<Collapsible
	data-slot="plan"
	class={cn(
		"rounded-lg border border-border bg-background shadow-none",
		className,
	)}
	bind:open
	{...restProps}
>
	{@render children?.()}
</Collapsible>
