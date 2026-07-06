<script lang="ts">
import { ACP_AGENTS, type AcpAgentId, type AgentStatus } from "@revv/shared";
import Check from "phosphor-svelte/lib/Check";
import { acpAgentIcon } from "$lib/components/icons/acpAgentIcon";
import {
  Content as PopoverContent,
  Root as PopoverRoot,
  Trigger as PopoverTrigger,
} from "$lib/components/ui/popover/index.js";
import {
  cascadeChatAgentChange,
  fetchAgentStatus,
  fetchModels,
  getAgentStatus,
  getSettings,
  resolveChatAgentId,
  updateSettings,
} from "$lib/stores/settings.svelte";
import SelectTrigger from "./SelectTrigger.svelte";

let open = $state(false);

// The selected agent (single `aiAgent`) so the trigger reflects what runs.
let currentId = $derived(resolveChatAgentId(getSettings()));
let current = $derived(ACP_AGENTS.find((a) => a.id === currentId));
let currentLabel = $derived(current?.label ?? "Agent");
let CurrentIcon = $derived(acpAgentIcon(current?.icon ?? "generic"));
let status = $state(getAgentStatus());
let currentStatus = $derived(status?.agents[currentId] ?? null);

$effect(() => {
  if (!open) return;
  void refreshStatus();
});

async function refreshStatus(): Promise<void> {
  status = await fetchAgentStatus();
}

function isReady(s: AgentStatus | null | undefined): boolean {
  return !!s?.installed && s.authed;
}

function statusLabel(s: AgentStatus | null | undefined): string {
  if (!s) return "Not checked";
  if (!s.installed) return "Not installed";
  if (!s.authed) return "Needs sign-in";
  return s.authLabel;
}

function statusDotClass(s: AgentStatus | null | undefined): string {
  if (!s) return "bg-text-muted";
  if (isReady(s) && s.verified) return "bg-success";
  return "bg-warning";
}

function select(id: AcpAgentId) {
  // opencode's catalog is dynamic — kick off a fetch so the cascade can pick a
  // real default model (and the model selector renders without a round-trip).
  if (id === "opencode") void fetchModels("opencode");
  void updateSettings(cascadeChatAgentChange(id));
  open = false;
}
</script>

<PopoverRoot bind:open>
	<PopoverTrigger>
		<SelectTrigger label={currentLabel}>
			{#snippet icon()}
				<div class={`h-1.5 w-1.5 rounded-full ${statusDotClass(currentStatus)}`}></div>
				<CurrentIcon size={12} class="text-text-muted" />
			{/snippet}
		</SelectTrigger>
	</PopoverTrigger>
	<PopoverContent class="w-64 p-1" align="start" side="top">
		{#each ACP_AGENTS as opt (opt.id)}
			{@const OptIcon = acpAgentIcon(opt.icon)}
			{@const optStatus = status?.agents[opt.id] ?? null}
			<button
				class="flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-text-secondary transition-colors hover:bg-bg-tertiary"
				onclick={() => select(opt.id)}
			>
				<OptIcon size={12} class="text-text-muted" />
				<span class={`h-1.5 w-1.5 shrink-0 rounded-full ${statusDotClass(optStatus)}`}></span>
				<span class="min-w-0 flex-1 text-left">
					<span class="block truncate text-text-primary">{opt.label}</span>
					<span class="block truncate text-[11px] text-text-muted">{statusLabel(optStatus)}</span>
				</span>
				{#if currentId === opt.id}
					<Check size={12} weight="regular" class="text-accent" />
				{/if}
			</button>
		{/each}
	</PopoverContent>
</PopoverRoot>
