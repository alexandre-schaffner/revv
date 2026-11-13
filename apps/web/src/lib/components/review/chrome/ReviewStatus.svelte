<script lang="ts">
import ArrowsClockwise from "phosphor-svelte/lib/ArrowsClockwise";
import ContextUsage from "$lib/components/agent-activity/ContextUsage.svelte";
import { getPrById } from "$lib/stores/prs.svelte";
import {
  getLastSyncAt,
  getSyncError,
  getThreadsSyncing,
  requestFullSync,
} from "$lib/stores/sync.svelte";
import { now } from "$lib/utils/clock.svelte";
import { formatRelativeTime } from "$lib/utils/format-relative-time";
import { getTokenUsage } from "$lib/walkthrough/store.svelte";
import CommitsDropdown from "./CommitsDropdown.svelte";

interface Props {
  prId: string;
}

let { prId }: Props = $props();

const pr = $derived(getPrById(prId));
const lastSyncAt = $derived(getLastSyncAt(prId));
const syncing = $derived(getThreadsSyncing(prId));
const syncError = $derived(getSyncError(prId));

const usage = $derived(getTokenUsage(prId));
// `contextWindowTokens` comes from the agent's ACP `usage_update.size`, which
// an agent may leave unknown. Revv always runs at the full window, so the
// fallback is a constant rather than a setting.
const FALLBACK_CONTEXT_WINDOW = 1_000_000;
const maxContext = $derived(usage.contextWindowTokens ?? FALLBACK_CONTEXT_WINDOW);

const syncLabel = $derived(
  lastSyncAt ? formatRelativeTime(lastSyncAt, { now: now(1000), seconds: true }) : "",
);

function handleRetrySync() {
  if (!syncing) requestFullSync(prId);
}
</script>

<ContextUsage usedTokens={usage.contextTokens} maxTokens={maxContext} {usage} />
<span class="h-3 w-px shrink-0 bg-border"></span>
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
{#if pr}
	<span class="h-3 w-px shrink-0 bg-border"></span>
	<CommitsDropdown {pr} />
{/if}
