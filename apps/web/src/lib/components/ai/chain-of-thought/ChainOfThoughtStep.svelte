<script lang="ts" module>
	import type { HTMLAttributes } from "svelte/elements";
	import type { Component } from "svelte";
	import type { ChainOfThoughtStepStatus } from "./context.js";

	export type ChainOfThoughtStepProps = HTMLAttributes<HTMLDivElement> & {
		/** Icon component to display for the step. */
		icon?: Component;
		/** The main text label for the step. */
		label: string;
		/** Optional description text shown below the label. */
		description?: string;
		/** Visual status of the step. */
		status?: ChainOfThoughtStepStatus;
	};
</script>

<script lang="ts">
	import { cn } from "$lib/utils.js";
	import { Dot, Check, Loader2 } from "@lucide/svelte";

	let {
		icon,
		label,
		description,
		status = "complete",
		children,
		class: className,
		...restProps
	}: ChainOfThoughtStepProps = $props();
</script>

<div
	data-slot="chain-of-thought-step"
	data-status={status}
	class={cn(
		"flex items-start gap-2 rounded-md px-2 py-1 text-xs",
		status === "active" && "text-foreground",
		status === "complete" && "text-muted-foreground",
		status === "pending" && "text-muted-foreground/60",
		className,
	)}
	{...restProps}
>
	<span class="mt-0.5 shrink-0">
		{#if icon}
			{@const Icon = icon}
			<Icon class="size-3" />
		{:else if status === "active"}
			<Loader2 class="size-3 motion-essential-spin animate-spin" />
		{:else if status === "complete"}
			<Check class="size-3" />
		{:else}
			<Dot class="size-3" />
		{/if}
	</span>
	<div class="flex flex-col gap-0.5">
		<span class={cn(status === "complete" && "line-through opacity-70")}>{label}</span>
		{#if description}
			<span class="text-muted-foreground/60">{description}</span>
		{/if}
		{@render children?.()}
	</div>
</div>
