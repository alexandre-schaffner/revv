<script lang="ts" module>
	import type { HTMLAttributes } from "svelte/elements";

	export type QueueItemIndicatorProps = HTMLAttributes<HTMLSpanElement> & {
		/** Whether the item is completed. */
		completed?: boolean;
	};
</script>

<script lang="ts">
	import { cn } from "$lib/utils.js";

	let {
		completed = false,
		class: className,
		...restProps
	}: QueueItemIndicatorProps = $props();
</script>

<span
	data-slot="queue-item-indicator"
	class={cn(
		"inline-block size-2.5 shrink-0 rounded-full border",
		completed
			? "border-muted-foreground/20 bg-muted-foreground/10"
			: "border-muted-foreground/50",
		className,
	)}
	{...restProps}
></span>
