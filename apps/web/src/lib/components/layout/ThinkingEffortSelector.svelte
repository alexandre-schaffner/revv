<script lang="ts">
import type { AiAgent, ThinkingEffort } from "@revv/shared";
import Brain from "phosphor-svelte/lib/Brain";
import Check from "phosphor-svelte/lib/Check";
import {
  Content as PopoverContent,
  Root as PopoverRoot,
  Trigger as PopoverTrigger,
} from "$lib/components/ui/popover/index.js";
import {
  agentSupportsThinkingEffort,
  OPUS_ONLY_EFFORTS,
  THINKING_EFFORT_OPTIONS,
} from "$lib/constants/models";
import { getSettings, updateSettings } from "$lib/stores/settings.svelte";
import SelectTrigger from "./SelectTrigger.svelte";

let open = $state(false);
let currentAgent = $derived((getSettings()?.aiAgent ?? "opencode") as AiAgent);
let currentModel = $derived(getSettings()?.aiModel ?? "");
let isOpus48 = $derived(currentModel === "claude-opus-4-8");
let visible = $derived(agentSupportsThinkingEffort(currentAgent));
let options = $derived(
  isOpus48
    ? THINKING_EFFORT_OPTIONS
    : THINKING_EFFORT_OPTIONS.filter((o) => !OPUS_ONLY_EFFORTS.has(o.value)),
);
let currentEffort = $derived((getSettings()?.aiThinkingEffort ?? "medium") as ThinkingEffort);
let currentLabel = $derived(options.find((o) => o.value === currentEffort)?.label ?? "High");

// If a restricted effort is selected and model changes away from Opus 4.8, reset to 'high'
$effect(() => {
  if (!isOpus48 && OPUS_ONLY_EFFORTS.has(currentEffort)) {
    updateSettings({ aiThinkingEffort: "high" });
  }
});

function select(value: ThinkingEffort) {
  updateSettings({ aiThinkingEffort: value });
  open = false;
}
</script>

{#if visible}
    <PopoverRoot bind:open>
        <PopoverTrigger>
            <SelectTrigger label={currentLabel}>
                {#snippet icon()}
                    <Brain size={12} class="text-text-muted" />
                {/snippet}
            </SelectTrigger>
        </PopoverTrigger>
        <PopoverContent class="w-40 p-1" align="start" side="top">
            {#each options as opt (opt.value)}
                <button
                    class="flex w-full cursor-pointer items-center justify-between rounded-sm px-2 py-1.5 text-xs text-text-secondary transition-colors hover:bg-bg-tertiary"
                    onclick={() => select(opt.value)}
                >
                    {opt.label}
                    {#if currentEffort === opt.value}
                        <Check size={12} weight="regular" class="text-accent" />
                    {/if}
                </button>
            {/each}
        </PopoverContent>
    </PopoverRoot>
{/if}
