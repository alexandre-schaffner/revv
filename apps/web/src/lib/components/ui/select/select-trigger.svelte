<script lang="ts">
	import { Select as SelectPrimitive } from "bits-ui";
	import { cn } from "$lib/utils.js";
	import ChevronDown from "@lucide/svelte/icons/chevron-down";

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
		"flex h-8 items-center justify-between gap-2 rounded-md border border-border bg-bg-elevated px-3 py-1.5 text-sm text-text-primary transition-colors hover:bg-bg-tertiary focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent disabled:cursor-not-allowed disabled:opacity-50",
		className
	)}
	{...restProps}
>
	{@render children?.()}
	<ChevronDown size={14} class="shrink-0 text-text-muted" />
</SelectPrimitive.Trigger>
