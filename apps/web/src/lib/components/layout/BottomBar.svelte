<script lang="ts">
	import AgentSelector from './AgentSelector.svelte';
	import ModelSelector from './ModelSelector.svelte';
	import ThinkingEffortSelector from './ThinkingEffortSelector.svelte';
	import { RefreshCw } from '@lucide/svelte';
	import { getSelectedPr, getSelectedPrId } from '$lib/stores/prs.svelte';
	import { getLastSyncAt, getSyncing, getSyncError } from '$lib/stores/sync.svelte';
	import { requestFullSync } from '$lib/stores/ws.svelte';

	const pr = $derived(getSelectedPr());
	const selectedPrId = $derived(getSelectedPrId());
	const lastSyncAt = $derived(getLastSyncAt());
	const syncing = $derived(getSyncing());
	const syncError = $derived(getSyncError());

	let tick = $state(0);
	$effect(() => {
		const id = setInterval(() => tick++, 1000);
		return () => clearInterval(id);
	});

	function formatSyncAge(iso: string | null): string {
		if (!iso) return '';
		const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
		if (diff < 10) return 'just now';
		if (diff < 60) return `${diff}s ago`;
		const mins = Math.floor(diff / 60);
		if (mins < 60) return `${mins}m ago`;
		return `${Math.floor(mins / 60)}h ago`;
	}

	const syncLabel = $derived((() => { void tick; return formatSyncAge(lastSyncAt); })());

	function handleRetrySync() {
		if (!syncing && selectedPrId) {
			requestFullSync(selectedPrId);
		}
	}
</script>

<div class="flex h-full items-center justify-between bg-bg-primary px-4">
	<!-- Left: PR ref + model info -->
	<div class="flex items-center gap-3">
		{#if pr}
			<span class="truncate font-mono text-[10px] text-text-muted">{pr.sourceBranch}</span>
			<span class="h-3 w-px shrink-0 bg-border"></span>
		{/if}
		<div class="flex items-center gap-0.5">
			<AgentSelector />
			<ModelSelector />
			<ThinkingEffortSelector />
		</div>
	</div>

	<!-- Right: sync indicator + action buttons -->
	<div class="flex items-center gap-2">
		{#if pr && lastSyncAt !== null}
			<button
				class="flex items-center gap-1.5 text-[10px] text-text-muted rounded px-1 py-0.5 transition-colors hover:bg-bg-elevated hover:text-text-secondary disabled:cursor-default disabled:opacity-60"
				onclick={handleRetrySync}
				disabled={syncing}
				title="Sync comments"
			>
				{#if syncing}
					<span class="flex items-center animate-spin"><RefreshCw size={11} /></span>
					<span class="whitespace-nowrap">Syncing…</span>
				{:else if syncError}
					<RefreshCw size={11} />
					<span class="whitespace-nowrap text-red-400">Sync failed</span>
				{:else}
					<RefreshCw size={11} />
					<span class="whitespace-nowrap">Synced {syncLabel}</span>
				{/if}
			</button>
			<span class="h-3 w-px shrink-0 bg-border"></span>
		{/if}
		<button
			class="rounded-md px-2.5 py-1 text-xs text-text-muted transition-colors hover:bg-bg-tertiary hover:text-text-secondary"
		>
			Build
		</button>
		<button
			class="rounded-md px-2.5 py-1 text-xs text-text-muted transition-colors hover:bg-bg-tertiary hover:text-text-secondary"
		>
			Lint
		</button>
		<button
			class="flex h-6 w-6 items-center justify-center rounded-full bg-accent text-white transition-colors hover:bg-accent-hover"
			aria-label="Submit"
		>
			<svg
				xmlns="http://www.w3.org/2000/svg"
				width="12"
				height="12"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2.5"
				stroke-linecap="round"
				stroke-linejoin="round"
			>
				<path d="m5 12 7-7 7 7" />
				<path d="M12 19V5" />
			</svg>
		</button>
	</div>
</div>
