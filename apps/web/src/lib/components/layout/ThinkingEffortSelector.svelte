<script lang="ts">
    import {
        Root as PopoverRoot,
        Trigger as PopoverTrigger,
        Content as PopoverContent,
    } from "$lib/components/ui/popover/index.js";
    import { getSettings, updateSettings } from "$lib/stores/settings.svelte";
    import {
        agentSupportsThinkingEffort,
        THINKING_EFFORT_OPTIONS,
        OPUS_ONLY_EFFORTS,
    } from "$lib/constants/models";
    import type { ThinkingEffort, AiAgent } from "@revv/shared";
    import Brain from "@lucide/svelte/icons/brain";
    import ChevronDown from "@lucide/svelte/icons/chevron-down";
    import Check from "@lucide/svelte/icons/check";

    let open = $state(false);
    let currentAgent = $derived(
        (getSettings()?.aiAgent ?? "opencode") as AiAgent,
    );
    let currentModel = $derived(getSettings()?.aiModel ?? "");
    let isOpus47 = $derived(currentModel === "claude-opus-4-7");
    let visible = $derived(agentSupportsThinkingEffort(currentAgent));
    let options = $derived(
        isOpus47
            ? THINKING_EFFORT_OPTIONS
            : THINKING_EFFORT_OPTIONS.filter((o) => !OPUS_ONLY_EFFORTS.has(o.value)),
    );
    let currentEffort = $derived(
        (getSettings()?.aiThinkingEffort ?? "medium") as ThinkingEffort,
    );
    let currentLabel = $derived(
        options.find((o) => o.value === currentEffort)?.label ?? "High",
    );

    // If a restricted effort is selected and model changes away from Opus 4.7, reset to 'high'
    $effect(() => {
        if (!isOpus47 && OPUS_ONLY_EFFORTS.has(currentEffort)) {
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
            <button
                class="flex items-center gap-1.5 rounded-md px-2 py-1 transition-colors hover:bg-bg-secondary"
            >
                <Brain size={12} class="text-text-muted" />
                <span class="text-xs text-text-secondary">{currentLabel}</span>
                <ChevronDown size={10} class="text-text-muted" />
            </button>
        </PopoverTrigger>
        <PopoverContent class="w-40 p-1" align="start" side="top">
            {#each options as opt (opt.value)}
                <button
                    class="flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-xs text-text-secondary transition-colors hover:bg-bg-tertiary"
                    onclick={() => select(opt.value)}
                >
                    {opt.label}
                    {#if currentEffort === opt.value}
                        <Check size={12} class="text-accent" />
                    {/if}
                </button>
            {/each}
        </PopoverContent>
    </PopoverRoot>
{/if}
