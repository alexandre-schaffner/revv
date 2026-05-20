<script lang="ts">
import type { AiAgent, ContextWindow } from "@revv/shared";
import Check from "phosphor-svelte/lib/Check";
import { SvelteMap } from "svelte/reactivity";
import ProviderIcon from "$lib/components/icons/ProviderIcon.svelte";
import {
  Content as PopoverContent,
  Root as PopoverRoot,
  Trigger as PopoverTrigger,
} from "$lib/components/ui/popover/index.js";
import {
  areModelsLoaded,
  fetchModels,
  getAvailableModels,
  getSettings,
  updateSettings,
} from "$lib/stores/settings.svelte";
import SelectTrigger from "./SelectTrigger.svelte";

const CONTEXT_WINDOW_OPTIONS: { label: string; value: ContextWindow }[] = [
  { label: "200K", value: "200k" },
  { label: "1M", value: "1m" },
];

let open = $state(false);

let currentAgent = $derived((getSettings()?.aiAgent ?? "opencode") as AiAgent);
// Read models for the *current* agent straight from the cached store.
// This eliminates the race where a local fetch could resolve with models
// for an agent the user has already switched away from.
let fetchedModels = $derived(getAvailableModels(currentAgent));
let fetchDone = $derived(areModelsLoaded(currentAgent));
let currentModel = $derived(getSettings()?.aiModel ?? "");
let currentLabel = $derived(
  !fetchDone
    ? "Loading..."
    : fetchedModels.length === 0
      ? "No models"
      : (fetchedModels.find((m) => m.value === currentModel)?.label ??
        (currentModel || "Select model")),
);

// Cache-miss fallback: if the bootstrap prefetch hasn't populated this
// agent's models yet (e.g. the server was unreachable at app start), kick
// off a single fetch. `fetchModels` internally de-dupes concurrent calls.
$effect(() => {
  const agent = currentAgent;
  if (!areModelsLoaded(agent)) {
    void fetchModels(agent);
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
  if (currentAgent !== "opencode") return [];
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
let currentWindow = $derived((getSettings()?.aiContextWindow ?? "200k") as ContextWindow);

function select(value: string) {
  updateSettings({ aiModel: value });
  // Keep popover open so the user can also pick the context window in one session
}

function selectWindow(value: ContextWindow) {
  updateSettings({ aiContextWindow: value });
  open = false;
}
</script>

<PopoverRoot bind:open>
	<PopoverTrigger>
		<SelectTrigger label={currentLabel}>
			{#snippet icon()}
				<ProviderIcon provider={currentProvider} size={14} class="shrink-0 opacity-60 text-text-secondary" />
			{/snippet}
			{#snippet trailing()}
				{#if currentAgent === 'claude'}
					<span class="text-xs text-text-muted">·</span>
					<span class="text-xs text-text-secondary">{currentWindow === '1m' ? '1M' : '200K'}</span>
				{/if}
			{/snippet}
		</SelectTrigger>
	</PopoverTrigger>
	<PopoverContent
		class="max-h-80 w-56 overflow-y-auto p-1"
		align="start"
		side="top"
	>
		{#if currentAgent === 'opencode'}
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
						class="flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-text-secondary transition-colors hover:bg-bg-tertiary"
						onclick={() => select(opt.value)}
					>
					<ProviderIcon provider={group.provider} size={14} class="shrink-0 opacity-60 text-text-secondary" />
					<span class="min-w-0 flex-1 truncate text-left">{opt.label}</span>
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

		{#if currentAgent === 'claude'}
			<div class="my-1 border-t border-border"></div>
			<div class="px-2 pt-2 pb-1 text-xs font-medium uppercase tracking-wider text-text-muted">
				Context Window
			</div>
			{#each CONTEXT_WINDOW_OPTIONS as opt (opt.value)}
				<button
					class="flex w-full cursor-pointer items-center justify-between rounded-sm px-2 py-1.5 text-xs text-text-secondary transition-colors hover:bg-bg-tertiary"
					onclick={() => selectWindow(opt.value)}
				>
					{opt.label}
					{#if currentWindow === opt.value}
						<Check size={12} class="shrink-0 text-accent" />
					{/if}
				</button>
			{/each}
		{/if}
	</PopoverContent>
</PopoverRoot>
