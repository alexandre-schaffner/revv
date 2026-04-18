<script lang="ts">
	/**
	 * Dev-only Cache Inspector panel.
	 * Toggled with Cmd+Shift+C from +layout.svelte (dev builds only).
	 * Shows KV cache namespace stats, GitHub ETag metrics, and file content cache hit rates.
	 */
	import { onMount } from 'svelte';
	import { X, RefreshCw } from '@lucide/svelte';

	interface NamespaceStat {
		ns: string;
		entries: number;
	}

	interface KvStats {
		hits: number;
		misses: number;
		inflightDedups: number;
		namespaces: NamespaceStat[];
	}

	interface GitHubStats {
		hits304: number;
		misses200: number;
		bytesSaved: number;
	}

	interface FileContentStats {
		hits: number;
		misses: number;
	}

	interface CacheStats {
		kv: KvStats;
		github: GitHubStats;
		fileContent: FileContentStats;
	}

	let { onclose }: { onclose: () => void } = $props();

	let stats = $state<CacheStats | null>(null);
	let loading = $state(false);
	let error = $state<string | null>(null);

	async function fetchStats(): Promise<void> {
		loading = true;
		error = null;
		try {
			const res = await fetch('/api/_debug/cache', { credentials: 'include' });
			if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
			stats = (await res.json()) as CacheStats;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to fetch cache stats';
		} finally {
			loading = false;
		}
	}

	function formatBytes(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}

	function hitRate(hits: number, misses: number): string {
		const total = hits + misses;
		if (total === 0) return '—';
		return `${((hits / total) * 100).toFixed(1)}%`;
	}

	onMount(() => {
		void fetchStats();
	});
</script>

<div class="inspector-overlay" role="dialog" aria-label="Cache Inspector">
	<div class="inspector-panel">
		<div class="inspector-header">
			<span class="inspector-title">Cache Inspector</span>
			<div class="inspector-actions">
				<button class="icon-btn" onclick={fetchStats} title="Refresh stats" aria-label="Refresh">
					<RefreshCw size={14} />
				</button>
				<button class="icon-btn" onclick={onclose} title="Close" aria-label="Close">
					<X size={14} />
				</button>
			</div>
		</div>

		{#if loading}
			<div class="inspector-loading">Loading…</div>
		{:else if error}
			<div class="inspector-error">{error}</div>
		{:else if stats}
			<!-- GitHub ETag Cache -->
			<section class="inspector-section">
				<h3 class="section-title">GitHub REST (ETag)</h3>
				<table class="stats-table">
					<tbody>
						<tr>
							<td class="stat-label">304 hits</td>
							<td class="stat-value">{stats.github.hits304}</td>
						</tr>
						<tr>
							<td class="stat-label">200 fetches</td>
							<td class="stat-value">{stats.github.misses200}</td>
						</tr>
						<tr>
							<td class="stat-label">Hit rate</td>
							<td class="stat-value">{hitRate(stats.github.hits304, stats.github.misses200)}</td>
						</tr>
						<tr>
							<td class="stat-label">Bytes saved</td>
							<td class="stat-value">{formatBytes(stats.github.bytesSaved)}</td>
						</tr>
					</tbody>
				</table>
			</section>

			<!-- File Content Cache -->
			<section class="inspector-section">
				<h3 class="section-title">File Content</h3>
				<table class="stats-table">
					<tbody>
						<tr>
							<td class="stat-label">Hits</td>
							<td class="stat-value">{stats.fileContent.hits}</td>
						</tr>
						<tr>
							<td class="stat-label">Misses</td>
							<td class="stat-value">{stats.fileContent.misses}</td>
						</tr>
						<tr>
							<td class="stat-label">Hit rate</td>
							<td class="stat-value">{hitRate(stats.fileContent.hits, stats.fileContent.misses)}</td>
						</tr>
					</tbody>
				</table>
			</section>

			<!-- KV Cache -->
			<section class="inspector-section">
				<h3 class="section-title">KV Cache</h3>
				<table class="stats-table">
					<tbody>
						<tr>
							<td class="stat-label">Hits</td>
							<td class="stat-value">{stats.kv.hits}</td>
						</tr>
						<tr>
							<td class="stat-label">Misses</td>
							<td class="stat-value">{stats.kv.misses}</td>
						</tr>
						<tr>
							<td class="stat-label">Hit rate</td>
							<td class="stat-value">{hitRate(stats.kv.hits, stats.kv.misses)}</td>
						</tr>
						<tr>
							<td class="stat-label">In-flight dedups</td>
							<td class="stat-value">{stats.kv.inflightDedups}</td>
						</tr>
					</tbody>
				</table>

				{#if stats.kv.namespaces.length > 0}
					<h4 class="subsection-title">Namespaces</h4>
					<table class="stats-table">
						<tbody>
							{#each stats.kv.namespaces as ns (ns.ns)}
								<tr>
									<td class="stat-label">{ns.ns}</td>
									<td class="stat-value">{ns.entries} entries</td>
								</tr>
							{/each}
						</tbody>
					</table>
				{/if}
			</section>
		{:else}
			<div class="inspector-loading">No data</div>
		{/if}
	</div>
</div>

<style>
	.inspector-overlay {
		position: fixed;
		bottom: 16px;
		right: 16px;
		z-index: 9999;
	}

	.inspector-panel {
		background: var(--color-bg-elevated);
		border: 1px solid var(--color-border);
		border-radius: 8px;
		width: 320px;
		max-height: 480px;
		overflow-y: auto;
		font-size: 12px;
		color: var(--color-text-primary);
		box-shadow: var(--color-shadow-lg);
	}

	.inspector-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 8px 12px;
		border-bottom: 1px solid var(--color-border, #333);
		position: sticky;
		top: 0;
		background: var(--color-surface-1, #1a1a1a);
	}

	.inspector-title {
		font-weight: 600;
		font-size: 12px;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		opacity: 0.7;
	}

	.inspector-actions {
		display: flex;
		gap: 4px;
	}

	.icon-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 24px;
		height: 24px;
		border: none;
		background: transparent;
		color: inherit;
		cursor: pointer;
		border-radius: 4px;
		opacity: 0.6;
		transition: opacity 120ms ease;
	}

	.icon-btn:hover {
		opacity: 1;
		background: var(--color-surface-2, #2a2a2a);
	}

	.inspector-loading,
	.inspector-error {
		padding: 16px 12px;
		opacity: 0.6;
		text-align: center;
	}

	.inspector-error {
		color: var(--color-danger, #ef4444);
		opacity: 1;
	}

	.inspector-section {
		padding: 10px 12px;
		border-bottom: 1px solid var(--color-border, #222);
	}

	.inspector-section:last-child {
		border-bottom: none;
	}

	.section-title {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		opacity: 0.5;
		margin: 0 0 6px 0;
	}

	.subsection-title {
		font-size: 10px;
		font-weight: 600;
		opacity: 0.4;
		margin: 8px 0 4px 0;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.stats-table {
		width: 100%;
		border-collapse: collapse;
	}

	.stats-table tbody tr + tr td {
		padding-top: 3px;
	}

	.stat-label {
		color: var(--color-text-muted, #888);
		min-width: 120px;
	}

	.stat-value {
		text-align: right;
		font-family: var(--font-mono, monospace);
		font-size: 11px;
	}
</style>
