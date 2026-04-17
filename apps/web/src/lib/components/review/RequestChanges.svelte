<script lang="ts">
	import { getIssues } from '$lib/stores/walkthrough.svelte';
	import { getThreads, getThreadMessages } from '$lib/stores/review.svelte';
	import { api } from '$lib/api/client';
	import { toast } from 'svelte-sonner';
	import { AlertTriangle, MessageSquare, Check, X, Sparkles } from '@lucide/svelte';

	interface Props {
		prId: string;
	}
	let { prId }: Props = $props();

	type Action = 'approve' | 'request_changes' | 'comment';

	const issues = $derived(getIssues());
	const threads = $derived(getThreads());
	const unresolvedThreads = $derived(threads.filter((t) => t.status !== 'resolved' && t.status !== 'wont_fix'));

	let selectedIssueIds = $state<Set<string>>(new Set());
	let selectedThreadIds = $state<Set<string>>(new Set());
	let submitting = $state<Action | null>(null);
	let submitError = $state<string | null>(null);
	let submitSuccess = $state<{ action: Action; htmlUrl: string } | null>(null);

	const selectedCount = $derived(selectedIssueIds.size + selectedThreadIds.size);

	function severityIcon(s: 'info' | 'warning' | 'critical'): string {
		return s === 'critical' ? '🔴' : s === 'warning' ? '🟡' : 'ℹ️';
	}

	function buildBody(): string {
		const parts: string[] = [];
		const selectedIssues = issues.filter((i) => selectedIssueIds.has(i.id));
		if (selectedIssues.length > 0) {
			parts.push('### Walkthrough issues');
			for (const issue of selectedIssues) {
				const loc =
					issue.filePath && issue.startLine != null
						? ` — \`${issue.filePath}:${issue.startLine}${issue.endLine != null && issue.endLine !== issue.startLine ? `–${issue.endLine}` : ''}\``
						: issue.filePath
							? ` — \`${issue.filePath}\``
							: '';
				parts.push(
					`- ${severityIcon(issue.severity)} **${issue.title}**${loc}\n  ${issue.description}`,
				);
			}
		}
		return parts.join('\n\n');
	}

	function buildComments(): Array<{
		path: string;
		body: string;
		line: number;
		side: 'LEFT' | 'RIGHT';
		startLine?: number;
	}> {
		const out: Array<{
			path: string;
			body: string;
			line: number;
			side: 'LEFT' | 'RIGHT';
			startLine?: number;
		}> = [];
		for (const thread of unresolvedThreads) {
			if (!selectedThreadIds.has(thread.id)) continue;
			const messages = getThreadMessages(thread.id);
			const body = messages.map((m) => m.body).filter((b) => b.trim().length > 0).join('\n\n');
			if (!body) continue;
			const comment: {
				path: string;
				body: string;
				line: number;
				side: 'LEFT' | 'RIGHT';
				startLine?: number;
			} = {
				path: thread.filePath,
				body,
				line: thread.endLine,
				side: thread.diffSide === 'old' ? 'LEFT' : 'RIGHT',
			};
			if (thread.startLine !== thread.endLine) {
				comment.startLine = thread.startLine;
			}
			out.push(comment);
		}
		return out;
	}

	async function submit(action: Action): Promise<void> {
		if (submitting) return;
		submitting = action;
		submitError = null;
		submitSuccess = null;
		try {
			const body = buildBody();
			const comments = buildComments();
			const { data, error } = await api.api
				.reviews({ id: prId })
				['github-submit']
				.post({ action, body, comments });
			if (error) {
				const msg =
					typeof error.value === 'object' && error.value !== null && 'error' in error.value
						? String((error.value as { error: unknown }).error)
						: `HTTP ${error.status}`;
				throw new Error(msg);
			}
		const payload = data as { htmlUrl?: string } | null;
		submitSuccess = { action, htmlUrl: payload?.htmlUrl ?? '' };
		toast.success(actionLabel(action) + ' on GitHub');
		selectedIssueIds = new Set();
			selectedThreadIds = new Set();
	} catch (e) {
		const msg = e instanceof Error ? e.message : 'Failed to submit review';
		submitError = msg;
		toast.error(msg);
	} finally {
			submitting = null;
		}
	}

	function actionLabel(a: Action): string {
		if (a === 'approve') return 'Approved';
		if (a === 'request_changes') return 'Changes requested';
		return 'Comments posted';
	}

	const allIssuesSelected = $derived(
		issues.length > 0 && issues.every((i) => selectedIssueIds.has(i.id))
	);
	const allThreadsSelected = $derived(
		unresolvedThreads.length > 0 && unresolvedThreads.every((t) => selectedThreadIds.has(t.id))
	);

	function toggleIssue(id: string) {
		const next = new Set(selectedIssueIds);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		selectedIssueIds = next;
	}

	function toggleThread(id: string) {
		const next = new Set(selectedThreadIds);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		selectedThreadIds = next;
	}

	function toggleAllIssues() {
		if (allIssuesSelected) {
			selectedIssueIds = new Set();
		} else {
			selectedIssueIds = new Set(issues.map((i) => i.id));
		}
	}

	function toggleAllThreads() {
		if (allThreadsSelected) {
			selectedThreadIds = new Set();
		} else {
			selectedThreadIds = new Set(unresolvedThreads.map((t) => t.id));
		}
	}

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
				{#if issues.length > 0}
					<button
						type="button"
						class="rc-select-all"
						onclick={toggleAllIssues}
					>
						{allIssuesSelected ? 'Clear' : 'Select all'}
					</button>
				{/if}
			</div>

			{#if issues.length === 0}
				<div class="rc-empty">No issues flagged by walkthrough</div>
			{:else}
				<ul class="rc-list">
					{#each issues as issue (issue.id)}
						{@const checked = selectedIssueIds.has(issue.id)}
						<li class="rc-item" class:rc-item-selected={checked}>
							<label class="rc-item-label">
								<input
									type="checkbox"
									class="rc-checkbox"
									{checked}
									onchange={() => toggleIssue(issue.id)}
								/>
								<div class="rc-item-body">
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
													>:{issue.startLine}{issue.endLine != null &&
													issue.endLine !== issue.startLine
														? `–${issue.endLine}`
														: ''}</span
												>
											{/if}
										</div>
									{/if}
									<p class="rc-item-desc">{issue.description}</p>
								</div>
							</label>
						</li>
					{/each}
				</ul>
			{/if}
		</section>

			<!-- Unresolved Comment Threads -->
		<section class="rc-section">
			<div class="rc-section-header">
				<MessageSquare size={14} />
				<span>Unresolved Comments</span>
				<span class="rc-badge">{unresolvedThreads.length}</span>
				{#if unresolvedThreads.length > 0}
					<button
						type="button"
						class="rc-select-all"
						onclick={toggleAllThreads}
					>
						{allThreadsSelected ? 'Clear' : 'Select all'}
					</button>
				{/if}
			</div>

			{#if unresolvedThreads.length === 0}
				<div class="rc-empty">No unresolved comment threads</div>
			{:else}
				<ul class="rc-list">
					{#each unresolvedThreads as thread (thread.id)}
						{@const checked = selectedThreadIds.has(thread.id)}
						<li class="rc-item" class:rc-item-selected={checked}>
							<label class="rc-item-label">
								<input
									type="checkbox"
									class="rc-checkbox"
									{checked}
									onchange={() => toggleThread(thread.id)}
								/>
								<div class="rc-item-body">
									<div class="rc-item-loc">
										<span class="rc-filepath" title={thread.filePath}
											>{formatPath(thread.filePath)}</span
										>
										<span class="rc-line-range"
											>:{thread.startLine}–{thread.endLine}</span
										>
									</div>
									{#if thread.status !== 'open'}
										<span class="thread-status thread-status-{thread.status}">{thread.status.replace('_', ' ')}</span>
									{/if}
								</div>
							</label>
						</li>
					{/each}
				</ul>
			{/if}
		</section>
	</div>

	<footer class="rc-footer">
		<div class="rc-actions">
			<button
				type="button"
				class="action-btn action-comment"
				disabled={submitting !== null || selectedCount === 0}
				onclick={() => submit('comment')}
				title={selectedCount === 0
					? 'Select at least one item to post comments'
					: 'Post selected items as GitHub review comments'}
			>
				<Sparkles size={14} />
				{submitting === 'comment' ? 'Generating…' : 'Generate changes'}
			</button>
			<button
				type="button"
				class="action-btn action-approve"
				disabled={submitting !== null}
				onclick={() => submit('approve')}
				title="Approve this pull request on GitHub"
			>
				<Check size={14} />
				{submitting === 'approve' ? 'Approving…' : 'Approve'}
			</button>
			<button
				type="button"
				class="action-btn action-reject"
				disabled={submitting !== null || selectedCount === 0}
				onclick={() => submit('request_changes')}
				title={selectedCount === 0
					? 'Select at least one item to request changes'
					: 'Request changes on this pull request'}
			>
				<X size={14} />
				{submitting === 'request_changes' ? 'Submitting…' : 'Submit Review'}
			</button>
		</div>

		{#if submitError}
			<span class="rc-status rc-status-error">{submitError}</span>
		{:else if submitSuccess}
			<span class="rc-status rc-status-success">
				{actionLabel(submitSuccess.action)} on GitHub.
				{#if submitSuccess.htmlUrl}
					<a href={submitSuccess.htmlUrl} target="_blank" rel="noreferrer noopener">View</a>
				{/if}
			</span>
		{:else}
			<span class="propose-hint">
				{selectedCount === 0
					? 'Approve directly, or tick items to include in comments / request changes'
					: `${selectedCount} item${selectedCount === 1 ? '' : 's'} selected`}
			</span>
		{/if}
	</footer>
</div>

<style>
	.request-changes {
		display: flex;
		flex-direction: column;
		background: var(--color-bg-primary);
	}

	.rc-sections {
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

	.rc-select-all {
		background: none;
		border: none;
		padding: 2px 6px;
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--color-accent);
		cursor: pointer;
		border-radius: 4px;
		transition: background var(--duration-snap);
	}

	.rc-select-all:hover {
		background: color-mix(in srgb, var(--color-accent) 12%, transparent);
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
		transition:
			border-color var(--duration-snap),
			background var(--duration-snap);
	}

	.rc-item-selected {
		border-color: color-mix(in srgb, var(--color-accent) 55%, transparent);
		background: color-mix(in srgb, var(--color-accent) 6%, var(--color-bg-secondary));
	}

	.rc-item-label {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		padding: 10px 12px;
		cursor: pointer;
	}

	.rc-checkbox {
		margin: 2px 0 0;
		width: 14px;
		height: 14px;
		accent-color: var(--color-accent);
		cursor: pointer;
		flex-shrink: 0;
	}

	.rc-item-body {
		display: flex;
		flex-direction: column;
		gap: 4px;
		flex: 1;
		min-width: 0;
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

	.rc-actions {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 8px;
	}

	.action-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		height: 38px;
		padding: 0 10px;
		border-radius: 8px;
		font-size: 12px;
		font-weight: 600;
		letter-spacing: -0.01em;
		border: 1px solid var(--color-border);
		background: var(--color-bg-secondary);
		color: var(--color-text-primary);
		cursor: pointer;
		transition:
			background var(--duration-snap),
			border-color var(--duration-snap),
			opacity var(--duration-snap),
			filter var(--duration-snap);
	}

	.action-btn:disabled {
		cursor: not-allowed;
		opacity: 0.4;
	}

	.action-btn:not(:disabled):hover {
		filter: brightness(1.05);
	}

	.action-comment:not(:disabled) {
		background: var(--color-accent);
		border-color: var(--color-accent);
		color: #fff;
	}

	.action-approve:not(:disabled) {
		background: transparent;
		border-color: var(--color-success, #22c55e);
		color: var(--color-success, #22c55e);
	}

	.action-approve:not(:disabled):hover {
		background: color-mix(in srgb, var(--color-success, #22c55e) 88%, black);
		border-color: var(--color-success, #22c55e);
		color: #fff;
		filter: none;
	}

	.action-reject:not(:disabled) {
		background: color-mix(in srgb, var(--color-danger, #ef4444) 88%, black);
		border-color: var(--color-danger, #ef4444);
		color: #fff;
	}

	.propose-hint {
		font-size: 11px;
		color: var(--color-text-muted);
		text-align: center;
	}

	.rc-status {
		font-size: 11px;
		text-align: center;
		line-height: 1.5;
	}

	.rc-status-error {
		color: var(--color-danger, #ef4444);
	}

	.rc-status-success {
		color: var(--color-success, #22c55e);
	}

	.rc-status a {
		color: inherit;
		text-decoration: underline;
		margin-left: 4px;
	}

	.thread-status {
		display: inline-flex;
		align-items: center;
		border-radius: 4px;
		padding: 1px 6px;
		font-size: 10px;
		font-weight: 700;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		flex-shrink: 0;
		margin-top: 2px;
		width: fit-content;
	}

	.thread-status-pending_coder,
	.thread-status-pending_reviewer {
		background: color-mix(in srgb, var(--color-warning) 15%, transparent);
		color: var(--color-warning);
		border: 1px solid color-mix(in srgb, var(--color-warning) 30%, transparent);
	}
</style>
