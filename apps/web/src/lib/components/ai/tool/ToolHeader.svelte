<script lang="ts" module>
	import type { Collapsible as CollapsiblePrimitive } from "bits-ui";
	import type { ToolState } from "./context.js";

	export type ToolHeaderProps = Omit<CollapsiblePrimitive.TriggerProps, 'type'> & {
		/** Custom title to display instead of the derived tool name. */
		title?: string;
		/** The type/name of the tool. */
		toolType: string;
		/** The current state of the tool. */
		state: ToolState;
	};
</script>

<script lang="ts">
	import { cn } from "$lib/utils.js";
	import { CollapsibleTrigger } from "$lib/components/ui/collapsible/index.js";
	import { Badge } from "$lib/components/ui/badge/index.js";
	import { ChevronRight, Loader2, Check, AlertCircle, Clock, ShieldQuestion, ShieldCheck, ShieldX } from "@lucide/svelte";
	import type { Component } from "svelte";

	let {
		title,
		toolType,
		state,
		children,
		class: className,
		...restProps
	}: ToolHeaderProps = $props();

	function deriveName(t: string): string {
		return t
			.replace(/^tool-/, "")
			.replace(/[_-]/g, " ")
			.replace(/\b\w/g, (c) => c.toUpperCase());
	}

	const statusConfig: Record<ToolState, { label: string; icon: Component; variant: string }> = {
		"input-streaming": { label: "Pending", icon: Clock, variant: "secondary" },
		"input-available": { label: "Running", icon: Loader2, variant: "secondary" },
		"approval-requested": { label: "Awaiting Approval", icon: ShieldQuestion, variant: "outline" },
		"approval-responded": { label: "Responded", icon: ShieldCheck, variant: "secondary" },
		"output-available": { label: "Completed", icon: Check, variant: "secondary" },
		"output-error": { label: "Error", icon: AlertCircle, variant: "destructive" },
		"output-denied": { label: "Denied", icon: ShieldX, variant: "destructive" },
	};

	let config = $derived(statusConfig[state]);
	let displayName = $derived(title ?? deriveName(toolType));
	let StatusIcon = $derived(config.icon);
</script>

<CollapsibleTrigger
	data-slot="tool-header"
	class={cn(
		"flex w-full items-center gap-2 px-3 py-2.5 text-sm transition-colors duration-snap hover:bg-muted/50",
		className,
	)}
	{...restProps}
>
	<ChevronRight class="size-3.5 shrink-0 text-muted-foreground transition-transform duration-snap [[data-state=open]_&]:rotate-90" />
	<span class="flex-1 text-left font-medium">{displayName}</span>
	<Badge variant="secondary" class="gap-1 text-[10px]">
		<StatusIcon class={cn("size-3", state === "input-available" && "motion-essential-spin animate-spin")} />
		{config.label}
	</Badge>
	{@render children?.()}
</CollapsibleTrigger>
