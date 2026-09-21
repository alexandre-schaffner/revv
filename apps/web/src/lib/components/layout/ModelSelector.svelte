<script lang="ts">
import { AUTO_MODEL_SENTINEL, type ContextWindow, getAgentCapabilities } from "@revv/shared";
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
import { fetchModelPreview, getModelPreview } from "$lib/stores/model-preview.svelte";
import { getSelectedPrId } from "$lib/stores/prs.svelte";
import {
  areModelsLoaded,
  fetchModels,
  getAvailableModels,
  getSettings,
  resolveChatAgentId,
  updateSettings,
} from "$lib/stores/settings.svelte";
import { getWalkthroughModelUsed } from "$lib/stores/walkthrough.svelte";
import SelectTrigger from "./SelectTrigger.svelte";

const CONTEXT_WINDOW_OPTIONS: { label: string; value: ContextWindow }[] = [
  { label: "200K", value: "200k" },
  { label: "1M", value: "1m" },
];

let open = $state(false);

// The model/context-window surface follows the selected `aiAgent`.
// Capabilities are the registry's single source of truth.
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
// The Auto option is offered only where it can do something: the TypeSafe
// auto-model toggle has to be on, and the agent needs a depth ladder the
// server can route onto. opencode's catalog is fetched live, so there is no
// static ladder and Auto would be a no-op — see `ai/jev/routing.ts`.
let autoModelOffered = $derived((getSettings()?.jev?.autoModel ?? false) && !isDynamic);
let isAuto = $derived(currentModel === AUTO_MODEL_SENTINEL);

function labelFor(value: string | null): string | null {
  if (!value) return null;
  return fetchedModels.find((m) => m.value === value)?.label ?? value;
}

/**
 * What Auto actually resolved to on this PR's most recent run.
 *
 * Worth showing even when routing declined and the agent default stood —
 * "Auto · Sonnet 5" tells you the sizing judged this a standard review,
 * which is exactly as informative as an upgrade.
 *
 * Null on a PR that hasn't generated yet, and deliberately not backfilled
 * with the agent default: Auto sizes *this* diff at generation time, so any
 * model named before then would be a guess presented as a fact. The
 * unknown state gets a qualifier of its own instead.
 */
let selectedPrId = $derived(getSelectedPrId());
let preview = $derived(getModelPreview(selectedPrId));

// Size the PR ahead of generation so the label can name a model rather than
// going blank. `pending` means the diff hasn't been cached yet, so retry
// once it has — the review page fetching its files is what unblocks it.
$effect(() => {
  if (!isAuto || selectedPrId === null) return;
  if (preview !== null && preview.status !== "pending") return;
  void fetchModelPreview(selectedPrId);
});

/**
 * What Auto resolved to for this PR — the model the last run actually
 * launched with, or the pre-generation sizing when nothing has run yet.
 *
 * A finished run wins over the preview: it is what happened, not what would
 * happen. `null` from the preview means routing declined and the agent's own
 * default stands, which is a real answer rather than a missing one.
 */
let autoResolvedLabel = $derived.by((): string | null => {
  if (!isAuto) return null;
  const fromRun = labelFor(getWalkthroughModelUsed());
  if (fromRun) return fromRun;
  if (preview?.status !== "ready") return null;
  return labelFor(preview.model) ?? labelFor(getDefaultModel(currentId));
});

let autoTitle = $derived(
  autoResolvedLabel
    ? `Auto picked ${autoResolvedLabel} for this pull request, from how intricate its diff looked.`
    : "Revv sizes the pull request and picks a model from how intricate its diff looks.",
);

let currentLabel = $derived(
  // Checked ahead of the loading/empty branches: Auto is a real selection
  // even while a dynamic catalog is still in flight, and without this the
  // trigger would render the raw sentinel string.
  isAuto
    ? autoResolvedLabel
      ? `Auto · ${autoResolvedLabel}`
      : "Auto · sizing…"
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
		<SelectTrigger label={currentLabel} title={isAuto ? autoTitle : undefined}>
			{#snippet icon()}
				{#if isAuto}
					<Sparkle size={14} class="shrink-0 opacity-60 text-text-secondary" />
				{:else}
					<ProviderIcon provider={currentProvider} size={14} class="shrink-0 opacity-60 text-text-secondary" />
				{/if}
			{/snippet}
			{#snippet trailing()}
				{#if caps.contextWindow}
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
		{#if autoModelOffered}
			<button
				class="flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-text-secondary transition-colors hover:bg-bg-tertiary"
				onclick={() => select(AUTO_MODEL_SENTINEL)}
			>
				<Sparkle size={14} class="shrink-0 opacity-60 text-text-secondary" />
				<span class="min-w-0 flex-1 truncate text-left">
					Auto
					<span class="text-text-muted">
						· {autoResolvedLabel ?? 'sizing…'}
					</span>
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

		{#if caps.contextWindow}
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
