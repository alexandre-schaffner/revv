<script lang="ts" module>
import type { Collapsible as CollapsiblePrimitive } from "bits-ui";
import type { ToolState } from "./context.js";

export type ToolHeaderProps = Omit<CollapsiblePrimitive.TriggerProps, "type"> & {
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
	import { ChevronDown, Wrench, Loader2, Check, AlertCircle, Clock, ShieldQuestion, ShieldCheck, ShieldX } from "@lucide/svelte";
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
		"approval-requested": { label: "Awaiting Approval", icon: ShieldQuestion, variant: "secondary" },
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
		"flex w-full items-center justify-between gap-4 p-3",
		className,
	)}
	{...restProps}
>
	<div class="flex items-center gap-2">
		<Wrench class="size-4 text-muted-foreground" />
		<span class="font-medium text-sm">{displayName}</span>
		<Badge variant="secondary" class="gap-1.5 rounded-full text-xs">
			<StatusIcon class={cn("size-4", state === "input-available" && "motion-essential-spin animate-spin")} />
			{config.label}
		</Badge>
	</div>
	<ChevronDown class="size-4 text-muted-foreground transition-transform duration-snap [[data-state=open]_&]:rotate-180" />
	{@render children?.()}
</CollapsibleTrigger>
