<script lang="ts" module>
	import type { HTMLAttributes } from "svelte/elements";

	export type MessageActionsProps = HTMLAttributes<HTMLDivElement>;
</script>

<script lang="ts">
	import { cn } from "$lib/utils.js";

	let {
		children,
		class: className,
		...restProps
	}: MessageActionsProps = $props();
</script>

<div
	data-slot="message-actions"
	class={cn(
		"flex items-center gap-1 opacity-0 transition-opacity duration-snap group-hover/message:opacity-100 focus-within:opacity-100",
		className,
	)}
	{...restProps}
>
	{@render children?.()}
</div>
