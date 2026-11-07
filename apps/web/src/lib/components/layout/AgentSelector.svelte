<script lang="ts">
import { ACP_AGENTS, type AcpAgentId, type AgentStatus } from "@revv/shared";
import Check from "phosphor-svelte/lib/Check";
import { onMount } from "svelte";
import { type AgentTone, agentReadiness } from "$lib/agent-setup/readiness";
import { selectAgent } from "$lib/agent-setup/store.svelte";
import { acpAgentIcon } from "$lib/components/icons/acpAgentIcon";
import {
  Content as PopoverContent,
  Root as PopoverRoot,
  Trigger as PopoverTrigger,
} from "$lib/components/ui/popover/index.js";
import { fetchAgentStatus, getAgentStatus, getSettings } from "$lib/stores/settings.svelte";
import SelectTrigger from "./SelectTrigger.svelte";

let open = $state(false);

let currentId = $derived(getSettings().aiAgent);
let current = $derived(ACP_AGENTS.find((a) => a.id === currentId));
let currentLabel = $derived(current?.label ?? "Agent");
let CurrentIcon = $derived(acpAgentIcon(current?.icon ?? "generic"));
let status = $derived(getAgentStatus());
let currentReadiness = $derived(agentReadiness(status?.agents[currentId]));

// The dot paints long before the popover is opened, so prime it here — otherwise
// a ready agent shows "Not checked" grey until the user opens this menu.
onMount(() => {
  if (!getAgentStatus()) void fetchAgentStatus();
});

$effect(() => {
  if (!open) return;
  void fetchAgentStatus();
});

const DOT_CLASS: Record<AgentTone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  muted: "bg-text-muted",
};

/** A ready agent names how it is signed in. */
function statusLabel(s: AgentStatus | undefined): string {
  const readiness = agentReadiness(s);
  return readiness.ready && s ? s.authLabel : readiness.label;
}

function select(id: AcpAgentId) {
  void selectAgent(id);
  open = false;
}
</script>

<PopoverRoot bind:open>
	<PopoverTrigger>
		<SelectTrigger label={currentLabel}>
			{#snippet icon()}
				<div class={`h-1.5 w-1.5 rounded-full ${DOT_CLASS[currentReadiness.tone]}`}></div>
				<CurrentIcon size={12} class="text-text-muted" />
			{/snippet}
		</SelectTrigger>
	</PopoverTrigger>
	<PopoverContent class="w-64 p-1" align="start" side="top">
		{#each ACP_AGENTS as opt (opt.id)}
			{@const OptIcon = acpAgentIcon(opt.icon)}
			{@const optStatus = status?.agents[opt.id]}
			<button
				class="flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-text-secondary transition-colors hover:bg-bg-tertiary"
				onclick={() => select(opt.id)}
			>
				<OptIcon size={12} class="text-text-muted" />
				<span class={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT_CLASS[agentReadiness(optStatus).tone]}`}></span>
				<span class="min-w-0 flex-1 text-left">
					<span class="block truncate text-text-primary">{opt.label}</span>
					<span class="block truncate text-[11px] text-text-muted">{statusLabel(optStatus)}</span>
				</span>
				{#if currentId === opt.id}
					<Check size={12} class="text-accent" />
				{/if}
			</button>
		{/each}
	</PopoverContent>
</PopoverRoot>
