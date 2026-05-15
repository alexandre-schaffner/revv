<script lang="ts" module>
import type { HTMLAttributes } from "svelte/elements";

export type MessageToolbarProps = HTMLAttributes<HTMLDivElement>;
</script>

<script lang="ts">
	import { cn } from "$lib/utils.js";

	let {
		children,
		class: className,
		...restProps
	}: MessageToolbarProps = $props();
</script>

<div
	data-slot="message-toolbar"
	class={cn("flex items-center justify-between", className)}
	{...restProps}
>
	{@render children?.()}
</div>
