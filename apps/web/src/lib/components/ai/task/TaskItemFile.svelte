<script lang="ts" module>
	import type { HTMLAttributes } from "svelte/elements";

	export type TaskItemFileProps = HTMLAttributes<HTMLSpanElement>;
</script>

<script lang="ts">
	import { cn } from "$lib/utils.js";

	let {
		children,
		class: className,
		...restProps
	}: TaskItemFileProps = $props();
</script>

<span
	data-slot="task-item-file"
	class={cn(
		"inline-flex items-center gap-1 rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-mono",
		className,
	)}
	{...restProps}
>
	{@render children?.()}
</span>
