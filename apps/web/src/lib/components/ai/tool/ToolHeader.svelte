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
import CaretDown from "phosphor-svelte/lib/CaretDown";
import Wrench from "phosphor-svelte/lib/Wrench";
import Spinner from "phosphor-svelte/lib/Spinner";
import Check from "phosphor-svelte/lib/Check";
import WarningCircle from "phosphor-svelte/lib/WarningCircle";
import Clock from "phosphor-svelte/lib/Clock";
import Shield from "phosphor-svelte/lib/Shield";
import ShieldCheck from "phosphor-svelte/lib/ShieldCheck";
import ShieldSlash from "phosphor-svelte/lib/ShieldSlash";
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
		"input-available": { label: "Running", icon: Spinner, variant: "secondary" },
		"approval-requested": { label: "Awaiting Approval", icon: Shield, variant: "secondary" },
		"approval-responded": { label: "Responded", icon: ShieldCheck, variant: "secondary" },
		"output-available": { label: "Completed", icon: Check, variant: "secondary" },
		"output-error": { label: "Error", icon: WarningCircle, variant: "destructive" },
		"output-denied": { label: "Denied", icon: ShieldSlash, variant: "destructive" },
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
			<StatusIcon class={cn("size-4", state === "input-available" && "motion-essential-spin")} />
			{config.label}
		</Badge>
	</div>
	<CaretDown class="size-4 text-muted-foreground transition-transform duration-snap [[data-state=open]_&]:rotate-180" />
	{@render children?.()}
</CollapsibleTrigger>
