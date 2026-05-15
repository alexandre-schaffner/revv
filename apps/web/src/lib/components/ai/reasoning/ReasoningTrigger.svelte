<script lang="ts" module>
	import type { Collapsible as CollapsiblePrimitive } from "bits-ui";
	import type { Snippet } from "svelte";

	export type ReasoningTriggerProps = Omit<CollapsiblePrimitive.TriggerProps, "children"> & {
		/** Custom function to format the thinking message. */
		getThinkingMessage?: (isStreaming: boolean, duration?: number) => string;
		children?: Snippet;
	};
</script>

<script lang="ts">
	import { getContext } from "svelte";
	import { cn } from "$lib/utils.js";
	import { CollapsibleTrigger } from "$lib/components/ui/collapsible/index.js";
	import { ChevronRight } from "@lucide/svelte";
	import { REASONING_CTX_KEY, type ReasoningContext } from "./context.js";

	let {
		getThinkingMessage,
		children,
		class: className,
		...restProps
	}: ReasoningTriggerProps = $props();

	const ctx = getContext<ReasoningContext>(REASONING_CTX_KEY);

	function defaultMessage(streaming: boolean, duration?: number): string {
		if (streaming) return "Thinking...";
		if (duration !== undefined) return `Thought for ${duration}s`;
		return "Thought process";
	}

	let label = $derived(
		getThinkingMessage
			? getThinkingMessage(ctx.isStreaming, ctx.duration)
			: defaultMessage(ctx.isStreaming, ctx.duration),
	);
</script>

<CollapsibleTrigger
	data-slot="reasoning-trigger"
	class={cn(
		"flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors duration-snap hover:bg-muted",
		className,
	)}
	{...restProps}
>
	<ChevronRight class="size-3 shrink-0 transition-transform duration-snap [[data-state=open]_&]:rotate-90" />
	<span class="flex items-center gap-1.5">
		{#if ctx.isStreaming}
			<span class="relative flex size-1.5">
				<span class="absolute inline-flex size-full animate-ping rounded-full bg-current opacity-50"></span>
				<span class="relative inline-flex size-1.5 rounded-full bg-current"></span>
			</span>
		{/if}
		{#if children}
			{@render children()}
		{:else}
			{label}
		{/if}
	</span>
</CollapsibleTrigger>
