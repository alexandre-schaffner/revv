<script lang="ts" module>
import type { HTMLAttributes } from "svelte/elements";

export type PlanTitleProps = HTMLAttributes<HTMLHeadingElement> & {
  text?: string;
};
</script>

<script lang="ts">
	import { cn } from "$lib/utils.js";

	let {
		text,
		children,
		class: className,
		...restProps
	}: PlanTitleProps = $props();
</script>

<h4
	data-slot="plan-title"
	class={cn("text-sm font-semibold", className)}
	{...restProps}
>
	{#if children}
		{@render children()}
	{:else if text}
		{text}
	{/if}
</h4>
