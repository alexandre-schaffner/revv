<script lang="ts">
	import { Select as SelectPrimitive } from "bits-ui";
	import type { Snippet } from "svelte";
	import { cn } from "$lib/utils.js";

	let {
		ref = $bindable(null),
		class: className,
		children: labelContent,
		...restProps
	}: Omit<SelectPrimitive.ItemProps, "children"> & { children?: Snippet } = $props();
</script>

<SelectPrimitive.Item
	bind:ref
	data-slot="select-item"
	class={cn(
		"relative flex w-full cursor-default select-none items-center rounded-sm py-1.5 pl-8 pr-2 text-sm text-text-primary outline-none hover:bg-bg-elevated focus:bg-bg-elevated data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-bg-elevated",
		className
	)}
	{...restProps}
>
	{#snippet children({ selected })}
		<span class="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
			{#if selected}
				<svg
					xmlns="http://www.w3.org/2000/svg"
					width="14"
					height="14"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2.5"
					stroke-linecap="round"
					stroke-linejoin="round"
					class="text-accent"
				>
					<polyline points="20 6 9 17 4 12" />
				</svg>
			{/if}
		</span>
		{@render labelContent?.()}
	{/snippet}
</SelectPrimitive.Item>
