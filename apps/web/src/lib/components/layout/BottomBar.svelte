<script lang="ts">
import { RefreshCw } from "@lucide/svelte";
import {
  Context,
  ContextCacheCreationUsage,
  ContextCacheReadUsage,
  ContextContent,
  ContextContentBody,
  ContextContentHeader,
  ContextInputUsage,
  ContextOutputUsage,
  ContextTrigger,
} from "$lib/components/ai/context";
import { getSelectedPr, getSelectedPrId } from "$lib/stores/prs.svelte";
import { getSettings } from "$lib/stores/settings.svelte";
import { getLastSyncAt, getSyncError, getThreadsSyncing } from "$lib/stores/sync.svelte";
import { getTokenUsage } from "$lib/stores/walkthrough.svelte";
import { requestFullSync } from "$lib/stores/ws.svelte";
import AgentSelector from "./AgentSelector.svelte";
import CommitsDropdown from "./CommitsDropdown.svelte";
import ModelSelector from "./ModelSelector.svelte";
import ThinkingEffortSelector from "./ThinkingEffortSelector.svelte";

const pr = $derived(getSelectedPr());
const selectedPrId = $derived(getSelectedPrId());
const lastSyncAt = $derived(getLastSyncAt(selectedPrId));
const syncing = $derived(getThreadsSyncing(selectedPrId));
const syncError = $derived(getSyncError(selectedPrId));

const usage = $derived(getTokenUsage(selectedPrId ?? undefined));
const totalTokens = $derived(
  usage.inputTokens +
    usage.outputTokens +
    usage.cacheReadInputTokens +
    usage.cacheCreationInputTokens,
);
const contextWindow = $derived(getSettings()?.aiContextWindow ?? "200k");
const maxContext = $derived(contextWindow === "1m" ? 1_000_000 : 200_000);
const showUsage = $derived(selectedPrId !== null);

let tick = $state(0);
$effect(() => {
  const id = setInterval(() => tick++, 1000);
  return () => clearInterval(id);
});

function formatSyncAge(iso: string | null): string {
  if (!iso) return "";
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 10) return "just now";
  if (diff < 60) return `${diff}s ago`;
  const mins = Math.floor(diff / 60);
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

const syncLabel = $derived(
  (() => {
    void tick;
    return formatSyncAge(lastSyncAt);
  })(),
);

function handleRetrySync() {
  if (!syncing && selectedPrId) {
    requestFullSync(selectedPrId);
  }
}
</script>

<div class="flex h-full items-center justify-between bg-bg-primary px-4">
	<!-- Left: model info -->
	<div class="flex items-center gap-3">
		<div class="flex items-center gap-0.5">
			<AgentSelector />
			<ModelSelector />
			<ThinkingEffortSelector />
		</div>
	</div>

	<!-- Right: usage indicator + sync + branch/sha -->
	<div class="flex items-center gap-2">
		{#if showUsage}
			<Context usedTokens={totalTokens} maxTokens={maxContext} {usage}>
				<ContextTrigger />
				<ContextContent>
					<ContextContentHeader />
					<ContextContentBody>
						<ContextInputUsage />
						<ContextOutputUsage />
						<ContextCacheReadUsage />
						<ContextCacheCreationUsage />
					</ContextContentBody>
				</ContextContent>
			</Context>
			<span class="h-3 w-px shrink-0 bg-border"></span>
		{/if}
		{#if selectedPrId}
			<button
				class="flex cursor-pointer items-center gap-1.5 text-xs tabular-nums text-text-muted rounded px-1 py-0.5 transition-colors hover:bg-bg-elevated hover:text-text-secondary disabled:cursor-default disabled:opacity-60"
				onclick={handleRetrySync}
				disabled={syncing}
				title="Sync comments for this PR"
			>
				{#if syncing}
					<span class="flex items-center animate-spin"><RefreshCw size={11} /></span>
					<span class="whitespace-nowrap">Syncing…</span>
				{:else if syncError}
					<RefreshCw size={11} />
					<span class="whitespace-nowrap text-danger">Sync failed</span>
				{:else if lastSyncAt}
					<RefreshCw size={11} />
					<span class="whitespace-nowrap">Synced {syncLabel}</span>
				{:else}
					<RefreshCw size={11} />
					<span class="whitespace-nowrap">Sync now</span>
				{/if}
			</button>
		{/if}
		{#if pr}
			<span class="h-3 w-px shrink-0 bg-border"></span>
			<CommitsDropdown {pr} />
		{/if}
	</div>
</div>
