<script lang="ts">
import ChevronDown from "@lucide/svelte/icons/chevron-down";
import { Select as SelectPrimitive } from "bits-ui";
import { cn } from "$lib/utils.js";

let {
  ref = $bindable(null),
  class: className,
  children,
  ...restProps
}: SelectPrimitive.TriggerProps = $props();
</script>

<SelectPrimitive.Trigger
	bind:ref
	data-slot="select-trigger"
	class={cn(
		"flex h-8 cursor-pointer items-center justify-between gap-2 rounded-lg border border-border bg-bg-elevated px-3 py-1.5 text-sm text-text-primary transition-colors hover:bg-bg-tertiary focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-3 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
		className
	)}
	{...restProps}
>
	{@render children?.()}
	<ChevronDown size={14} class="shrink-0 text-text-muted" />
</SelectPrimitive.Trigger>
