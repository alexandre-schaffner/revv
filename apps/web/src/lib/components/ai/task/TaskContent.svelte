<script lang="ts" module>
	import type { Collapsible as CollapsiblePrimitive } from "bits-ui";

	export type TaskContentProps = CollapsiblePrimitive.ContentProps;
</script>

<script lang="ts">
	import { cn } from "$lib/utils.js";
	import { CollapsibleContent } from "$lib/components/ui/collapsible/index.js";

	let {
		children,
		class: className,
		...restProps
	}: TaskContentProps = $props();
</script>

<CollapsibleContent
	data-slot="task-content"
	class={cn("border-t border-border", className)}
	{...restProps}
>
	<div class="space-y-0.5 px-3 py-2">
		{@render children?.()}
	</div>
</CollapsibleContent>
