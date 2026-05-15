<script lang="ts" module>
	import type { HTMLAttributes } from "svelte/elements";
	import type { Snippet } from "svelte";

	export type TaskItemProps = HTMLAttributes<HTMLDivElement> & {
		/** Optional leading indicator snippet (icon, bullet, checkbox, etc.). */
		indicator?: Snippet;
	};
</script>

<script lang="ts">
	import { cn } from "$lib/utils.js";

	let {
		indicator,
		children,
		class: className,
		...restProps
	}: TaskItemProps = $props();
</script>

<div
	data-slot="task-item"
	class={cn(
		"flex items-start gap-2 rounded-md px-2 py-1 text-xs text-muted-foreground",
		className,
	)}
	{...restProps}
>
	{#if indicator}
		{@render indicator()}
	{:else}
		<span class="mt-0.5 text-muted-foreground/60">&#8226;</span>
	{/if}
	<span class="flex-1">{@render children?.()}</span>
</div>
