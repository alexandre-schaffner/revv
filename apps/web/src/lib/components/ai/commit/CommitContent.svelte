<script lang="ts" module>
	import type { Collapsible as CollapsiblePrimitive } from "bits-ui";

	export type CommitContentProps = CollapsiblePrimitive.ContentProps;
</script>

<script lang="ts">
	import { cn } from "$lib/utils.js";
	import { CollapsibleContent } from "$lib/components/ui/collapsible/index.js";

	let {
		children,
		class: className,
		...restProps
	}: CommitContentProps = $props();
</script>

<CollapsibleContent
	data-slot="commit-content"
	class={cn("border-t border-border", className)}
	{...restProps}
>
	<div class="divide-y divide-border">
		{@render children?.()}
	</div>
</CollapsibleContent>
