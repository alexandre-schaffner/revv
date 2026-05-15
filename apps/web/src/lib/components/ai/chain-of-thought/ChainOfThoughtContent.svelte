<script lang="ts" module>
	import type { Collapsible as CollapsiblePrimitive } from "bits-ui";

	export type ChainOfThoughtContentProps = CollapsiblePrimitive.ContentProps;
</script>

<script lang="ts">
	import { cn } from "$lib/utils.js";
	import { CollapsibleContent } from "$lib/components/ui/collapsible/index.js";

	let {
		children,
		class: className,
		...restProps
	}: ChainOfThoughtContentProps = $props();
</script>

<CollapsibleContent
	data-slot="chain-of-thought-content"
	class={cn("mt-1 space-y-1", className)}
	{...restProps}
>
	{@render children?.()}
</CollapsibleContent>
