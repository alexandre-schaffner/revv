<script lang="ts" module>
import type { HTMLAttributes } from "svelte/elements";

export type QueueItemActionsProps = HTMLAttributes<HTMLDivElement>;
</script>

<script lang="ts">
	import { cn } from "$lib/utils.js";

	let {
		children,
		class: className,
		...restProps
	}: QueueItemActionsProps = $props();
</script>

<div
	data-slot="queue-item-actions"
	class={cn("flex gap-1", className)}
	{...restProps}
>
	{@render children?.()}
</div>
