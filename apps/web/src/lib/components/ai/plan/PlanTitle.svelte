<script lang="ts" module>
import type { HTMLAttributes } from "svelte/elements";

export type PlanTitleProps = HTMLAttributes<HTMLHeadingElement> & {
  /** The title text. Displays with shimmer animation when streaming. */
  text?: string;
};
</script>

<script lang="ts">
	import { getContext } from "svelte";
	import { cn } from "$lib/utils.js";
	import { Shimmer } from "$lib/components/ai/shimmer/index.js";
	import { PLAN_CTX_KEY, type PlanContext } from "./context.js";

	let {
		text,
		children,
		class: className,
		...restProps
	}: PlanTitleProps = $props();

	const ctx = getContext<PlanContext>(PLAN_CTX_KEY);
</script>

<h4
	data-slot="plan-title"
	class={cn("text-sm font-semibold", className)}
	{...restProps}
>
	{#if ctx.isStreaming && text}
		<Shimmer>{text}</Shimmer>
	{:else if children}
		{@render children()}
	{:else if text}
		{text}
	{/if}
</h4>
