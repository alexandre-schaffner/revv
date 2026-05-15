<script lang="ts" module>
import type { HTMLAttributes } from "svelte/elements";

export type QueueItemAttachmentProps = HTMLAttributes<HTMLDivElement>;
</script>

<script lang="ts">
	import { cn } from "$lib/utils.js";

	let {
		children,
		class: className,
		...restProps
	}: QueueItemAttachmentProps = $props();
</script>

<div
	data-slot="queue-item-attachment"
	class={cn("mt-1 flex flex-wrap gap-2", className)}
	{...restProps}
>
	{@render children?.()}
</div>
