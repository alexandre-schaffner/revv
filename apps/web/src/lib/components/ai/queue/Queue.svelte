<script lang="ts" module>
import type { HTMLAttributes } from "svelte/elements";

export type QueueProps = HTMLAttributes<HTMLDivElement>;
</script>

<script lang="ts">
	import { cn } from "$lib/utils.js";

	let {
		children,
		class: className,
		...restProps
	}: QueueProps = $props();
</script>

<div
	data-slot="queue"
	class={cn(
		"flex flex-col gap-2 rounded-xl border border-border bg-background px-3 pt-2 pb-2 shadow-xs",
		className,
	)}
	{...restProps}
>
	{@render children?.()}
</div>
