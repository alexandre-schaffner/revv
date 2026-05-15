<script lang="ts" module>
import type { HTMLAttributes } from "svelte/elements";

export type QueueItemContentProps = HTMLAttributes<HTMLSpanElement> & {
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
	}: QueueItemContentProps = $props();
</script>

<span
	data-slot="queue-item-content"
	class={cn(
		"line-clamp-1 grow break-words",
		completed
			? "text-muted-foreground/50 line-through"
			: "text-muted-foreground",
		className,
	)}
	{...restProps}
>
	{@render children?.()}
</span>
