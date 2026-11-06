<script lang="ts">
import ArrowsClockwise from "phosphor-svelte/lib/ArrowsClockwise";
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
import {
  getLastSyncAt,
  getSyncError,
  getThreadsSyncing,
  requestFullSync,
} from "$lib/stores/sync.svelte";
import { getTokenUsage } from "$lib/stores/walkthrough.svelte";
import { now } from "$lib/utils/clock.svelte";
import { formatRelativeTime } from "$lib/utils/format-relative-time";
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
const usedTokens = $derived(usage.contextTokens);
// `contextWindowTokens` is reported by the Claude Agent SDK only; codex and
// opencode runs leave it unset. Revv always runs at the full window, so the
// fallback is a constant rather than a setting.
const FALLBACK_CONTEXT_WINDOW = 1_000_000;
const maxContext = $derived(usage.contextWindowTokens ?? FALLBACK_CONTEXT_WINDOW);
const showUsage = $derived(selectedPrId !== null);

const syncLabel = $derived(
  lastSyncAt ? formatRelativeTime(lastSyncAt, { now: now(1000), seconds: true }) : "",
);

function handleRetrySync() {
  if (!syncing && selectedPrId) {
    requestFullSync(selectedPrId);
  }
}
</script>

<div class="bottombar-row">
	<!-- Left: model info -->
	<div class="bottombar-left">
		<div class="flex items-center gap-0.5">
			<AgentSelector />
			<ModelSelector />
			<ThinkingEffortSelector />
		</div>
	</div>

	<!-- Right: usage indicator + sync + branch/sha -->
	<div class="bottombar-right">
		{#if showUsage}
			<Context {usedTokens} maxTokens={maxContext} {usage}>
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
					<span class="flex items-center motion-essential-spin"><ArrowsClockwise size={11} /></span>
					<span class="whitespace-nowrap">Syncing…</span>
				{:else if syncError}
					<ArrowsClockwise size={11} />
					<span class="whitespace-nowrap text-danger">Sync failed</span>
				{:else if lastSyncAt}
					<ArrowsClockwise size={11} />
					<span class="whitespace-nowrap">Synced {syncLabel}</span>
				{:else}
					<ArrowsClockwise size={11} />
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

<style>
	.bottombar-row {
		display: flex;
		height: 100%;
		align-items: center;
		justify-content: space-between;
		background: var(--color-bg-secondary);
		padding: 0 var(--spacing-island-2x);
	}

	.bottombar-left {
		display: flex;
		align-items: center;
		gap: var(--spacing-inset);
	}

	.bottombar-right {
		display: flex;
		align-items: center;
		gap: var(--spacing-island);
	}
</style>
