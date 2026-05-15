<script lang="ts" module>
	import type { HTMLAttributes } from "svelte/elements";

	export type QueueItemFileProps = HTMLAttributes<HTMLSpanElement>;
</script>

<script lang="ts">
	import { cn } from "$lib/utils.js";
	import { Paperclip } from "@lucide/svelte";

	let {
		children,
		class: className,
		...restProps
	}: QueueItemFileProps = $props();
</script>

<span
	data-slot="queue-item-file"
	class={cn(
		"flex items-center gap-1 rounded border bg-muted px-2 py-1 text-xs",
		className,
	)}
	{...restProps}
>
	<Paperclip class="size-3" />
	<span class="max-w-[100px] truncate">{@render children?.()}</span>
</span>
