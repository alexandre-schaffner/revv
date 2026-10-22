<script lang="ts">
import { Select as SelectPrimitive } from "bits-ui";
import Check from "phosphor-svelte/lib/Check";
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
				<Check size={14} class="text-accent" />
			{/if}
		</span>
		{@render labelContent?.()}
	{/snippet}
</SelectPrimitive.Item>
