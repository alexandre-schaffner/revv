<script lang="ts" module>
import type { HTMLAttributes } from "svelte/elements";

export type QueueItemProps = HTMLAttributes<HTMLLIElement>;
</script>

<script lang="ts">
	import { cn } from "$lib/utils.js";

	let {
		children,
		class: className,
		...restProps
	}: QueueItemProps = $props();
</script>

<li
	data-slot="queue-item"
	class={cn(
		"group flex flex-col gap-1 rounded-md px-3 py-1 text-sm transition-colors duration-snap hover:bg-muted",
		className,
	)}
	{...restProps}
>
	{@render children?.()}
</li>
