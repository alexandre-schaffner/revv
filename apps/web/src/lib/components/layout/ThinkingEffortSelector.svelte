<script lang="ts">
import { AUTO_MODEL_SENTINEL, getAgentCapabilities, type ThinkingEffort } from "@revv/shared";
import Brain from "phosphor-svelte/lib/Brain";
import Check from "phosphor-svelte/lib/Check";
import {
  Content as PopoverContent,
  Root as PopoverRoot,
  Trigger as PopoverTrigger,
} from "$lib/components/ui/popover/index.js";
import { THINKING_EFFORT_OPTIONS } from "$lib/constants/models";
import { getPrById, getSelectedPrId } from "$lib/stores/prs.svelte";
import { getSettings, resolveChatAgentId, updateSettings } from "$lib/stores/settings.svelte";
import { getWalkthroughSizing } from "$lib/stores/walkthrough-sizing.svelte";
import SelectTrigger from "./SelectTrigger.svelte";

let open = $state(false);
// Thinking-effort options follow the selected chat agent's capabilities.
let currentId = $derived(resolveChatAgentId(getSettings()));
let caps = $derived(getAgentCapabilities(currentId));
let visible = $derived(caps.thinkingEfforts.length > 0);
let options = $derived(
  THINKING_EFFORT_OPTIONS.filter((o) => caps.thinkingEfforts.includes(o.value)),
);
let currentEffort = $derived((getSettings()?.aiThinkingEffort ?? "medium") as ThinkingEffort);

// Under "Auto" the sizing picks the effort as well as the model — the two are
// decided together from the same answers, so showing one and not the other
// would leave the effort selector quietly lying about what will run. No fetch
// here: `ModelSelector` and the review page already drive it, and this is a
// read of whatever they resolved.
let selectedPrId = $derived(getSelectedPrId());
let sizing = $derived(
  getWalkthroughSizing(
    selectedPrId,
    selectedPrId ? (getPrById(selectedPrId)?.headSha ?? null) : null,
  ),
);
let autoEffort = $derived(
  (getSettings()?.aiModel === AUTO_MODEL_SENTINEL && sizing?.status === "ready"
    ? sizing.thinkingEffort
    : null) ?? null,
);
let effectiveEffort = $derived(autoEffort ?? currentEffort);
let currentLabel = $derived(
  options.find((o) => o.value === effectiveEffort)?.label ?? options[0]?.label ?? "High",
);
let triggerTitle = $derived(
  autoEffort !== null
    ? "Sized for this pull request, from how much deliberation the change deserves. Pin a model to choose the effort yourself."
    : undefined,
);

// If the selected effort isn't valid for the current agent (e.g. a Claude-only
// tier after switching to codex, or any tier after switching to an agent with
// no thinking-effort knob), the launch path clamps it (see presets.ts). The
// persisted preference is intentionally left untouched here — switching back
// to the original agent should restore the original tier, not a clamped one.

function select(value: ThinkingEffort) {
  updateSettings({ aiThinkingEffort: value });
  open = false;
}
</script>

{#if visible}
    <PopoverRoot bind:open>
        <PopoverTrigger>
            <SelectTrigger label={currentLabel} title={triggerTitle}>
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
                    {#if effectiveEffort === opt.value}
                        <Check size={12} class="text-accent" />
                    {/if}
                </button>
            {/each}
        </PopoverContent>
    </PopoverRoot>
{/if}
