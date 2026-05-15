<script lang="ts" module>
	import type { Collapsible as CollapsiblePrimitive } from "bits-ui";

	export type ToolContentProps = CollapsiblePrimitive.ContentProps;
</script>

<script lang="ts">
	import { cn } from "$lib/utils.js";
	import { CollapsibleContent } from "$lib/components/ui/collapsible/index.js";

	let {
		children,
		class: className,
		...restProps
	}: ToolContentProps = $props();
</script>

<CollapsibleContent
	data-slot="tool-content"
	class={cn("border-t border-border", className)}
	{...restProps}
>
	<div class="space-y-3 px-3 py-3">
		{@render children?.()}
	</div>
</CollapsibleContent>
