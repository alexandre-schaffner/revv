<script lang="ts" module>
import type { Snippet } from "svelte";
import type { HTMLAttributes } from "svelte/elements";

export type QueueSectionLabelProps = HTMLAttributes<HTMLSpanElement> & {
  /** The label text to display. */
  label: string;
  /** The count to display before the label. */
  count?: number;
  /** An optional icon snippet to display before the count. */
  icon?: Snippet;
};
</script>

<script lang="ts">
	import { cn } from "$lib/utils.js";
	import { ChevronDown } from "@lucide/svelte";

	let {
		label,
		count,
		icon,
		class: className,
		...restProps
	}: QueueSectionLabelProps = $props();
</script>

<span
	data-slot="queue-section-label"
	class={cn("flex items-center gap-2", className)}
	{...restProps}
>
	<ChevronDown class="size-4 transition-transform duration-snap group-data-[state=closed]:-rotate-90" />
	{#if icon}
		{@render icon()}
	{/if}
	<span>
		{#if count !== undefined}{count}{/if}
		{label}
	</span>
</span>
