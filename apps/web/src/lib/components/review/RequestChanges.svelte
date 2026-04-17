<script lang="ts">
	import { getIssues } from '$lib/stores/walkthrough.svelte';
	import { getThreads, getReviewFiles, getRejectedHunks } from '$lib/stores/review.svelte';
	import { AlertTriangle, MessageSquare, XCircle, Zap } from '@lucide/svelte';

	interface Props {
		prId: string;
	}
	let { prId }: Props = $props();

	const issues = $derived(getIssues());
	const threads = $derived(getThreads());
	const reviewFiles = $derived(getReviewFiles());

	const openThreads = $derived(threads.filter((t) => t.status === 'open'));

	const rejectedHunkItems = $derived.by(() => {
		const items: { filePath: string; hunkIndex: number }[] = [];
		for (const file of reviewFiles) {
			const rejected = getRejectedHunks(file.path);
			for (const hunkIndex of rejected) {
				items.push({ filePath: file.path, hunkIndex });
			}
		}
		return items;
	});

	const totalCount = $derived(issues.length + openThreads.length + rejectedHunkItems.length);

	function severityLabel(severity: 'info' | 'warning' | 'critical'): string {
		return severity.charAt(0).toUpperCase() + severity.slice(1);
	}

	function formatPath(filePath: string): string {
		const parts = filePath.split('/');
		if (parts.length <= 2) return filePath;
		return '…/' + parts.slice(-2).join('/');
	}
</script>

<div class="request-changes">
	<div class="rc-sections">
		<!-- Issues from Walkthrough -->
		<section class="rc-section">
			<div class="rc-section-header">
				<AlertTriangle size={14} />
				<span>Walkthrough Issues</span>
				<span class="rc-badge">{issues.length}</span>
			</div>

			{#if issues.length === 0}
				<div class="rc-empty">No issues flagged by walkthrough</div>
			{:else}
				<ul class="rc-list">
					{#each issues as issue (issue.id)}
						<li class="rc-item">
							<div class="rc-item-top">
								<span class="severity-badge severity-{issue.severity}"
									>{severityLabel(issue.severity)}</span
								>
								<span class="rc-item-title">{issue.title}</span>
							</div>
							{#if issue.filePath}
								<div class="rc-item-loc">
									<span class="rc-filepath" title={issue.filePath}
										>{formatPath(issue.filePath)}</span
									>
									{#if issue.startLine != null}
										<span class="rc-line-range"
											>:{issue.startLine}{issue.endLine != null && issue.endLine !== issue.startLine
												? `–${issue.endLine}`
												: ''}</span
										>
									{/if}
								</div>
							{/if}
							<p class="rc-item-desc">{issue.description}</p>
						</li>
					{/each}
				</ul>
			{/if}
		</section>

		<!-- Open Comment Threads -->
		<section class="rc-section">
			<div class="rc-section-header">
				<MessageSquare size={14} />
				<span>Open Comments</span>
				<span class="rc-badge">{openThreads.length}</span>
			</div>

			{#if openThreads.length === 0}
				<div class="rc-empty">No open comment threads</div>
			{:else}
				<ul class="rc-list">
					{#each openThreads as thread (thread.id)}
						<li class="rc-item">
							<div class="rc-item-loc">
								<span class="rc-filepath" title={thread.filePath}
									>{formatPath(thread.filePath)}</span
								>
								<span class="rc-line-range">:{thread.startLine}–{thread.endLine}</span>
							</div>
						</li>
					{/each}
				</ul>
			{/if}
		</section>

		<!-- Rejected Hunks -->
		<section class="rc-section">
			<div class="rc-section-header">
				<XCircle size={14} />
				<span>Rejected Hunks</span>
			<span class="rc-badge">{rejectedHunkItems.length}</span>
		</div>

		{#if rejectedHunkItems.length === 0}
			<div class="rc-empty">No hunks rejected</div>
		{:else}
			<ul class="rc-list">
				{#each rejectedHunkItems as item (`${item.filePath}:${item.hunkIndex}`)}
						<li class="rc-item">
							<div class="rc-item-loc">
								<span class="rc-filepath" title={item.filePath}
									>{formatPath(item.filePath)}</span
								>
								<span class="rc-line-range">hunk #{item.hunkIndex + 1}</span>
							</div>
						</li>
					{/each}
				</ul>
			{/if}
		</section>
	</div>

	<footer class="rc-footer">
		<button class="propose-btn" disabled title="Propose changes via GitHub (coming soon)">
			<Zap size={14} />
			Propose Changes
		</button>
		<span class="propose-hint">Submit review with all flagged items to GitHub</span>
	</footer>
</div>

<style>
	.request-changes {
		display: flex;
		flex-direction: column;
		height: 100%;
		overflow: hidden;
		background: var(--color-bg-primary);
	}

	.rc-sections {
		flex: 1;
		overflow-y: auto;
		padding: 16px 24px;
		display: flex;
		flex-direction: column;
		gap: 20px;
	}

	.rc-section {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.rc-section-header {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--color-text-muted);
	}

	.rc-badge {
		margin-left: auto;
		font-size: 11px;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		color: var(--color-text-secondary);
	}

	.rc-empty {
		font-size: 12px;
		color: var(--color-text-muted);
		padding: 10px 0 4px;
		font-style: italic;
	}

	.rc-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.rc-item {
		background: var(--color-bg-secondary);
		border: 1px solid var(--color-border);
		border-radius: 6px;
		padding: 10px 12px;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.rc-item-top {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.rc-item-title {
		font-size: 12px;
		font-weight: 500;
		color: var(--color-text-primary);
		line-height: 1.4;
	}

	.rc-item-loc {
		display: flex;
		align-items: center;
		gap: 2px;
	}

	.rc-filepath {
		font-size: 11px;
		font-family: var(--font-mono);
		color: var(--color-text-secondary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		max-width: 240px;
	}

	.rc-line-range {
		font-size: 11px;
		font-family: var(--font-mono);
		color: var(--color-text-muted);
	}

	.rc-item-desc {
		margin: 0;
		font-size: 11px;
		color: var(--color-text-secondary);
		line-height: 1.5;
	}

	/* Severity badges */
	.severity-badge {
		display: inline-flex;
		align-items: center;
		border-radius: 4px;
		padding: 1px 6px;
		font-size: 10px;
		font-weight: 700;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		flex-shrink: 0;
	}

	.severity-critical {
		background: color-mix(in srgb, var(--color-danger) 15%, transparent);
		color: var(--color-danger);
		border: 1px solid color-mix(in srgb, var(--color-danger) 30%, transparent);
	}

	.severity-warning {
		background: color-mix(in srgb, var(--color-warning) 15%, transparent);
		color: var(--color-warning);
		border: 1px solid color-mix(in srgb, var(--color-warning) 30%, transparent);
	}

	.severity-info {
		background: color-mix(in srgb, var(--color-accent) 15%, transparent);
		color: var(--color-accent);
		border: 1px solid color-mix(in srgb, var(--color-accent) 30%, transparent);
	}

	/* Footer */
	.rc-footer {
		flex-shrink: 0;
		padding: 16px 24px 20px;
		border-top: 1px solid var(--color-border);
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.propose-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		width: 100%;
		height: 38px;
		border-radius: 8px;
		font-size: 13px;
		font-weight: 600;
		letter-spacing: -0.01em;
		background: var(--color-accent);
		color: #fff;
		border: none;
		cursor: not-allowed;
		opacity: 0.4;
		transition: opacity var(--duration-snap);
	}

	.propose-hint {
		font-size: 11px;
		color: var(--color-text-muted);
		text-align: center;
	}
</style>
