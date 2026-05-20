<script lang="ts">
import Check from "phosphor-svelte/lib/Check";
import type { AiAgent } from "@revv/shared";
import AnthropicIcon from "$lib/components/icons/AnthropicIcon.svelte";
import OpenCodeIcon from "$lib/components/icons/OpenCodeIcon.svelte";
import SelectTrigger from "./SelectTrigger.svelte";
import {
  Content as PopoverContent,
  Root as PopoverRoot,
  Trigger as PopoverTrigger,
} from "$lib/components/ui/popover/index.js";
import {
  cascadeAgentChange,
  fetchModels,
  getSettings,
  updateSettings,
} from "$lib/stores/settings.svelte";

const AGENT_OPTIONS = [
  { label: "OpenCode", value: "opencode" as AiAgent, icon: OpenCodeIcon },
  { label: "Claude Code", value: "claude" as AiAgent, icon: AnthropicIcon },
];

let open = $state(false);

let currentAgent = $derived((getSettings()?.aiAgent ?? "opencode") as AiAgent);
let currentLabel = $derived(
  AGENT_OPTIONS.find((a) => a.value === currentAgent)?.label ?? "OpenCode",
);
let CurrentIcon = $derived(
  AGENT_OPTIONS.find((a) => a.value === currentAgent)?.icon ?? OpenCodeIcon,
);

function select(value: AiAgent) {
  // If the cache is cold (e.g. app-start prefetch hadn't completed yet),
  // kick a fetch so subsequent agent switches are race-free.
  void fetchModels(value);
  // `cascadeAgentChange` re-picks `aiModel` against the new agent's
  // catalog and resets `aiSuggestionsModel` to the cheap default — same
  // logic the onboarding agent step and settings modal share.
  updateSettings(cascadeAgentChange(value));
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
		{#each AGENT_OPTIONS as opt (opt.value)}
			<button
				class="flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-text-secondary transition-colors hover:bg-bg-tertiary"
				onclick={() => select(opt.value)}
			>
				<opt.icon size={12} class="text-text-muted" />
				<span class="flex-1 text-left">{opt.label}</span>
				{#if currentAgent === opt.value}
					<Check size={12} class="text-accent" />
				{/if}
			</button>
		{/each}
	</PopoverContent>
</PopoverRoot>
