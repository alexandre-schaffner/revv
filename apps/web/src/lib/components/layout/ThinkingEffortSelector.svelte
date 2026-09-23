<script lang="ts">
import {
  AUTO_SENTINEL,
  getAgentCapabilities,
  isAutoSentinel,
  type ThinkingEffort,
  type ThinkingEffortSetting,
} from "@revv/shared";
import Brain from "phosphor-svelte/lib/Brain";
import Check from "phosphor-svelte/lib/Check";
import Sparkle from "phosphor-svelte/lib/Sparkle";
import {
  Content as PopoverContent,
  Root as PopoverRoot,
  Trigger as PopoverTrigger,
} from "$lib/components/ui/popover/index.js";
import { THINKING_EFFORT_OPTIONS } from "$lib/constants/models";
import { getSettings, resolveChatAgentId, updateSettings } from "$lib/stores/settings.svelte";
import { sizingForSelectedPr } from "$lib/stores/walkthrough-sizing.svelte";
import SelectTrigger from "./SelectTrigger.svelte";

let open = $state(false);
// Thinking-effort options follow the selected chat agent's capabilities.
let currentId = $derived(resolveChatAgentId(getSettings()));
let caps = $derived(getAgentCapabilities(currentId));
let visible = $derived(caps.thinkingEfforts.length > 0);
let options = $derived(
  THINKING_EFFORT_OPTIONS.filter((o) => caps.thinkingEfforts.includes(o.value)),
);
let stored = $derived(getSettings()?.aiThinkingEffort ?? "medium");
let isAuto = $derived(isAutoSentinel(stored));
let currentEffort = $derived(isAuto ? null : (stored as ThinkingEffort));

// Offered whenever TypeSafe is on; unlike the model selector, no
// dynamic-catalog exception since effort routing skips the depth ladder.
let autoOffered = $derived(getSettings()?.jev.enabled ?? false);

// What Auto resolves to for this PR at its current head; tracking the SHA re-sizes on pull.
const selectedSizing = sizingForSelectedPr(() => isAuto && autoOffered);
let sizing = $derived(selectedSizing.sizing);

let autoEffort = $derived(
  isAuto && sizing?.status === "ready" ? (sizing.thinkingEffort ?? null) : null,
);
let autoResolvedLabel = $derived(
  autoEffort === null ? null : (options.find((o) => o.value === autoEffort)?.label ?? autoEffort),
);
let effectiveEffort = $derived(autoEffort ?? currentEffort);
let currentLabel = $derived(
  isAuto
    ? `Auto${autoResolvedLabel ? ` · ${autoResolvedLabel}` : ""}`
    : (options.find((o) => o.value === effectiveEffort)?.label ?? options[0]?.label ?? "High"),
);
let triggerTitle = $derived(
  isAuto
    ? "Sized for this pull request, from how much deliberation the change deserves. Pick a tier to choose it yourself."
    : undefined,
);

// If the selected effort isn't valid for the current agent (e.g. a Claude-only
// tier after switching to codex, or any tier after switching to an agent with
// no thinking-effort knob), the launch path clamps it (see presets.ts). The
// persisted preference is intentionally left untouched here — switching back
// to the original agent should restore the original tier, not a clamped one.

function select(value: ThinkingEffortSetting) {
  updateSettings({ aiThinkingEffort: value });
  open = false;
}
</script>

{#if visible}
    <PopoverRoot bind:open>
        <PopoverTrigger>
            <SelectTrigger label={currentLabel} title={triggerTitle}>
                {#snippet icon()}
                    {#if isAuto}
                        <Sparkle size={12} class="text-text-muted" />
                    {:else}
                        <Brain size={12} class="text-text-muted" />
                    {/if}
                {/snippet}
            </SelectTrigger>
        </PopoverTrigger>
        <PopoverContent class="w-44 p-1" align="start" side="top">
            {#if autoOffered}
                <button
                    class="flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-text-secondary transition-colors hover:bg-bg-tertiary"
                    onclick={() => select(AUTO_SENTINEL)}
                >
                    <Sparkle size={12} class="shrink-0 text-text-muted" />
                    <span class="min-w-0 flex-1 truncate text-left">
                        Auto
                        {#if autoResolvedLabel}
                            <span class="text-text-muted">· {autoResolvedLabel}</span>
                        {/if}
                    </span>
                    {#if isAuto}
                        <Check size={12} class="shrink-0 text-accent" />
                    {/if}
                </button>
            {/if}
            {#each options as opt (opt.value)}
                <button
                    class="flex w-full cursor-pointer items-center justify-between rounded-sm px-2 py-1.5 text-xs text-text-secondary transition-colors hover:bg-bg-tertiary"
                    onclick={() => select(opt.value)}
                >
                    {opt.label}
                    {#if !isAuto && effectiveEffort === opt.value}
                        <Check size={12} class="text-accent" />
                    {/if}
                </button>
            {/each}
        </PopoverContent>
    </PopoverRoot>
{/if}
