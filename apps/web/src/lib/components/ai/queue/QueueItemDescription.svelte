<script lang="ts" module>
	import type { HTMLAttributes } from "svelte/elements";

	export type QueueItemDescriptionProps = HTMLAttributes<HTMLDivElement> & {
		/** Whether the item is completed. Affects text styling. */
		completed?: boolean;
	};
</script>

<script lang="ts">
	import { cn } from "$lib/utils.js";

	let {
		completed = false,
		children,
		class: className,
		...restProps
	}: QueueItemDescriptionProps = $props();
</script>

<div
	data-slot="queue-item-description"
	class={cn(
		"ml-6 text-xs",
		completed
			? "text-muted-foreground/40 line-through"
			: "text-muted-foreground",
		className,
	)}
	{...restProps}
>
	{@render children?.()}
</div>
