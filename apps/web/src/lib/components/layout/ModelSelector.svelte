<script lang="ts">
import { AUTO_SENTINEL, getAgentCapabilities } from "@revv/shared";
import Check from "phosphor-svelte/lib/Check";
import Sparkle from "phosphor-svelte/lib/Sparkle";
import { SvelteMap } from "svelte/reactivity";
import ProviderIcon from "$lib/components/icons/ProviderIcon.svelte";
import {
  Content as PopoverContent,
  Root as PopoverRoot,
  Trigger as PopoverTrigger,
} from "$lib/components/ui/popover/index.js";
import { getDefaultModel, type ModelOption } from "$lib/constants/models";
import {
  areModelsLoaded,
  fetchModels,
  getAvailableModels,
  getSettings,
  resolveChatAgentId,
  updateSettings,
} from "$lib/stores/settings.svelte";
import { getIsStreaming, getWalkthroughModelUsed } from "$lib/stores/walkthrough.svelte";
import { sizingForSelectedPr } from "$lib/stores/walkthrough-sizing.svelte";
import SelectTrigger from "./SelectTrigger.svelte";

let open = $state(false);

// The model surface follows `aiAgent`; capabilities are the registry's single source of truth.
let currentId = $derived(resolveChatAgentId(getSettings()));
let caps = $derived(getAgentCapabilities(currentId));
// opencode is the only agent whose catalog is fetched live; everything else
// uses the curated static list baked into the registry.
let isDynamic = $derived(caps.models === "dynamic");
let fetchedModels = $derived<ModelOption[]>(
  caps.models === "dynamic"
    ? getAvailableModels("opencode")
    : caps.models.map((m) => ({ label: m.label, value: m.value })),
);
let fetchDone = $derived(caps.models === "dynamic" ? areModelsLoaded("opencode") : true);
let currentModel = $derived(getSettings()?.aiModel ?? "");
// Auto needs the TypeSafe toggle on and a static depth ladder to route onto;
// opencode's catalog is fetched live, so it has no ladder. See `ai/jev/routing.ts`.
let autoModelOffered = $derived((getSettings()?.jev.enabled ?? false) && !isDynamic);
let isAuto = $derived(currentModel === AUTO_SENTINEL);

function labelFor(value: string | null): string | null {
  if (!value) return null;
  return fetchedModels.find((m) => m.value === value)?.label ?? value;
}

const selectedSizing = sizingForSelectedPr(() => isAuto && autoModelOffered);
let sizing = $derived(selectedSizing.sizing);

/**
 * What Auto resolves to for the PR at its *current* head.
 *
 * The preview leads: a finished run's model is stale after a pull, while the
 * preview is keyed on the current head and shares the server's sizing cache.
 * Exception: a run in flight is ground truth, even if it launched before a
 * settings change the preview already reflects. A `ready` preview with a
 * null model means routing declined, so it falls back to the agent's default.
 */
let autoResolvedLabel = $derived.by((): string | null => {
  if (!isAuto) return null;
  if (getIsStreaming()) {
    const running = labelFor(getWalkthroughModelUsed());
    if (running) return running;
  }
  if (sizing?.status !== "ready") return null;
  return labelFor(sizing.model) ?? labelFor(getDefaultModel(currentId));
});

/** Whether a sizing is actually outstanding; bare "Auto" when there's no PR to size. */
let autoSizing = $derived(isAuto && autoResolvedLabel === null && selectedSizing.pending);

let autoTitle = $derived(
  autoResolvedLabel
    ? `Auto picked ${autoResolvedLabel} for this pull request, from how intricate its diff looked. It is re-sized when new commits arrive.`
    : "Revv sizes the pull request and picks a model from how intricate its diff looks.",
);

let currentLabel = $derived(
  // Checked ahead of loading/empty: Auto is a real selection even mid-fetch,
  // and without this the trigger would render the raw sentinel string.
  isAuto
    ? autoResolvedLabel
      ? `Auto · ${autoResolvedLabel}`
      : autoSizing
        ? "Auto · sizing…"
        : "Auto"
    : !fetchDone
      ? "Loading..."
      : fetchedModels.length === 0
        ? "No models"
        : (fetchedModels.find((m) => m.value === currentModel)?.label ??
          (currentModel || "Select model")),
);

// Cache-miss fallback for opencode's dynamic catalog: if the bootstrap prefetch
// hasn't populated it yet, kick off a single (de-duped) fetch.
$effect(() => {
  if (caps.models === "dynamic" && !areModelsLoaded("opencode")) {
    void fetchModels("opencode");
  }
});

function getProvider(value: string): string | null {
  const idx = value.indexOf("/");
  return idx !== -1 ? value.slice(0, idx) : null;
}

function formatProvider(provider: string): string {
  const known: Record<string, string> = {
    "github-copilot": "GitHub Copilot",
    anthropic: "Anthropic",
    openai: "OpenAI",
    google: "Google",
    mistral: "Mistral",
    groq: "Groq",
    bedrock: "AWS Bedrock",
    azure: "Azure",
  };
  return known[provider] ?? provider.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

type ModelGroup = {
  provider: string | null;
  label: string;
  models: { label: string; value: string }[];
};

let groupedModels = $derived.by((): ModelGroup[] => {
  if (!isDynamic) return [];
  const map = new SvelteMap<string, { label: string; value: string }[]>();
  for (const m of fetchedModels) {
    const p = getProvider(m.value) ?? "__none__";
    if (!map.has(p)) map.set(p, []);
    map.get(p)?.push(m);
  }
  return Array.from(map.entries()).map(([p, models]) => ({
    provider: p === "__none__" ? null : p,
    label: p === "__none__" ? "" : formatProvider(p),
    models,
  }));
});

let currentProvider = $derived(getProvider(currentModel));

function select(value: string) {
  updateSettings({ aiModel: value });
  open = false;
}
</script>

<PopoverRoot bind:open>
	<PopoverTrigger>
		<SelectTrigger label={currentLabel} title={isAuto ? autoTitle : undefined}>
			{#snippet icon()}
				{#if isAuto}
					<Sparkle size={14} class="shrink-0 opacity-60 text-text-secondary" />
				{:else}
					<ProviderIcon provider={currentProvider} size={14} class="shrink-0 opacity-60 text-text-secondary" />
				{/if}
			{/snippet}
		</SelectTrigger>
	</PopoverTrigger>
	<PopoverContent
		class="max-h-80 w-56 overflow-y-auto p-1"
		align="start"
		side="top"
	>
		{#if autoModelOffered}
			<button
				class="flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-text-secondary transition-colors hover:bg-bg-tertiary"
				onclick={() => select(AUTO_SENTINEL)}
			>
				<Sparkle size={14} class="shrink-0 opacity-60 text-text-secondary" />
				<span class="min-w-0 flex-1 truncate text-left">
					Auto
					{#if autoResolvedLabel || autoSizing}
						<span class="text-text-muted">
							· {autoResolvedLabel ?? 'sizing…'}
						</span>
					{/if}
				</span>
				{#if isAuto}
					<Check size={12} class="shrink-0 text-accent" />
				{/if}
			</button>
			<div class="my-1 border-t border-border"></div>
		{/if}

		{#if isDynamic}
			{#each groupedModels as group, i (group.provider ?? '__none__')}
				{#if i > 0}
					<div class="my-1 border-t border-border"></div>
				{/if}
				{#if group.label}
					<div class="px-2 pt-2 pb-1 text-xs font-medium uppercase tracking-wider text-text-muted">
						{group.label}
					</div>
				{/if}
			{#each group.models as opt (opt.value)}
				<button
					class="flex w-full cursor-pointer items-center justify-between rounded-sm px-2 py-1.5 text-xs text-text-secondary transition-colors hover:bg-bg-tertiary"
					onclick={() => select(opt.value)}
				>
					<span class="min-w-0 truncate text-left">{opt.label}</span>
					{#if currentModel === opt.value}
						<Check size={12} class="shrink-0 text-accent" />
					{/if}
				</button>
			{/each}
		{/each}
	{:else}
		{#each fetchedModels as opt (opt.value)}
			<button
				class="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-text-secondary transition-colors hover:bg-bg-tertiary"
				onclick={() => select(opt.value)}
			>
				<ProviderIcon provider={getProvider(opt.value)} size={14} class="shrink-0 opacity-60 text-text-secondary" />
				<span class="min-w-0 flex-1 truncate text-left">{opt.label}</span>
				{#if currentModel === opt.value}
					<Check size={12} class="shrink-0 text-accent" />
				{/if}
			</button>
		{/each}
		{/if}

	</PopoverContent>
</PopoverRoot>
