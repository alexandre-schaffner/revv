<script lang="ts" module>
import type { HTMLAttributes } from "svelte/elements";

export type PlanDescriptionProps = HTMLAttributes<HTMLParagraphElement> & {
  /** The description text. Displays with shimmer animation when streaming. */
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
	}: PlanDescriptionProps = $props();

	const ctx = getContext<PlanContext>(PLAN_CTX_KEY);
</script>

<p
	data-slot="plan-description"
	class={cn("text-balance text-xs text-muted-foreground", className)}
	{...restProps}
>
	{#if ctx.isStreaming && text}
		<Shimmer>{text}</Shimmer>
	{:else if children}
		{@render children()}
	{:else if text}
		{text}
	{/if}
</p>
