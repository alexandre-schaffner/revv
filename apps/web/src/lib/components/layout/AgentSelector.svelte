<script lang="ts">
import { ACP_AGENTS, type AcpAgentId } from "@revv/shared";
import Check from "phosphor-svelte/lib/Check";
import { acpAgentIcon } from "$lib/components/icons/acpAgentIcon";
import {
  Content as PopoverContent,
  Root as PopoverRoot,
  Trigger as PopoverTrigger,
} from "$lib/components/ui/popover/index.js";
import {
  cascadeChatAgentChange,
  fetchModels,
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
				<div class="h-1.5 w-1.5 rounded-full bg-accent"></div>
				<CurrentIcon size={12} class="text-text-muted" />
			{/snippet}
		</SelectTrigger>
	</PopoverTrigger>
	<PopoverContent class="w-40 p-1" align="start" side="top">
		{#each ACP_AGENTS as opt (opt.id)}
			{@const OptIcon = acpAgentIcon(opt.icon)}
			<button
				class="flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-text-secondary transition-colors hover:bg-bg-tertiary"
				onclick={() => select(opt.id)}
			>
				<OptIcon size={12} class="text-text-muted" />
				<span class="flex-1 text-left">{opt.label}</span>
				{#if currentId === opt.id}
					<Check size={12} weight="regular" class="text-accent" />
				{/if}
			</button>
		{/each}
	</PopoverContent>
</PopoverRoot>
