<script lang="ts">
import Check from "phosphor-svelte/lib/Check";
import CheckCircle from "phosphor-svelte/lib/CheckCircle";
import X from "phosphor-svelte/lib/X";
import XCircle from "phosphor-svelte/lib/XCircle";
import type { PlanStatus } from "$lib/chat/timeline.svelte";
import Markdown from "$lib/components/markdown/Markdown.svelte";
import { Button } from "$lib/components/ui/button/index.js";
import { Collapsible, CollapsibleContent } from "$lib/components/ui/collapsible/index.js";
import { cn } from "$lib/utils.js";

interface Props {
  markdown: string;
  status: PlanStatus;
  /** The decision buttons are disabled while a turn streams. */
  disabled: boolean;
  onApprove: () => void;
  onReject: () => void;
}

let { markdown, status, disabled, onApprove, onReject }: Props = $props();

let open = $state(true);
</script>

<Collapsible
	data-slot="plan"
	class={cn(
		"rounded-lg border border-border bg-background shadow-none",
		status === "rejected" ? "opacity-85 border-destructive/35" : status === "approved" ? "border-success/35" : "",
	)}
	bind:open
>
	<div data-slot="plan-header" class="flex items-start justify-between gap-2 px-4 pt-3 pb-2">
		<h4 data-slot="plan-title" class="text-sm font-semibold">Plan</h4>
		{#if status === "approved"}
			<span class="ml-auto inline-flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-xs font-semibold uppercase tracking-wider text-success">
				<CheckCircle class="size-2.5" />
				Approved
			</span>
		{:else if status === "rejected"}
			<span class="ml-auto inline-flex items-center gap-1 rounded-full bg-destructive/15 px-2 py-0.5 text-xs font-semibold uppercase tracking-wider text-destructive">
				<XCircle class="size-2.5" />
				Rejected
			</span>
		{:else if status === "superseded"}
			<span class="ml-auto inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
				Superseded
			</span>
		{/if}
	</div>
	<CollapsibleContent data-slot="plan-content" class="px-4 pb-3">
		<Markdown source={markdown} trust="agent" />
	</CollapsibleContent>
	{#if status === "pending"}
		<div data-slot="plan-footer" class="flex items-center justify-end gap-2 px-4 py-2">
			<Button data-slot="plan-action" size="sm" variant="outline" onclick={onReject} {disabled}>
				<X data-icon="inline-start" />
				Reject
			</Button>
			<Button data-slot="plan-action" size="sm" onclick={onApprove} {disabled}>
				<Check data-icon="inline-start" />
				Approve & continue
			</Button>
		</div>
	{/if}
</Collapsible>
