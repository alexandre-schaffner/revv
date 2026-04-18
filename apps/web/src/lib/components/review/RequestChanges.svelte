<script lang="ts">
	import { getIssues, getRatings, getBlocks } from '$lib/stores/walkthrough.svelte';
	import { getThreads, getThreadMessages, loadSession, jumpToDiffLine } from '$lib/stores/review.svelte';
	import { api } from '$lib/api/client';
	import { toast } from 'svelte-sonner';
	import { AlertTriangle, MessageSquare, Check, ArrowUp, Sparkles } from '@lucide/svelte';
	import WalkthroughRatingsPanel from '$lib/components/walkthrough/WalkthroughRatingsPanel.svelte';
	import IssueCard from '$lib/components/walkthrough/IssueCard.svelte';
	import FileBadge from '$lib/components/ui/FileBadge.svelte';
	import ApproveWithIssuesDialog from './ApproveWithIssuesDialog.svelte';
	import { groupIssuesBySeverityWithIndex } from '$lib/utils/walkthrough-issues';

	// Module-level: survives component remount, keyed by PR ID
	const _submittedByPr = new Map<string, Set<string>>();

	interface Props {
		prId: string;
	}
	let { prId }: Props = $props();

	type Action = 'approve' | 'request_changes';

	const issues = $derived(getIssues());
	const issueGroups = $derived(groupIssuesBySeverityWithIndex(issues));
	const threads = $derived(getThreads());
	const unresolvedThreads = $derived(threads.filter((t) => t.status !== 'resolved' && t.status !== 'wont_fix'));
	const ratings = $derived(getRatings());
	const blocks = $derived(getBlocks());

	let selectedIssueIds = $state<Set<string>>(new Set());
	let submittedIssueIds = $state<Set<string>>((() => _submittedByPr.get(prId) ?? new Set())());
	let submitting = $state<Action | null>(null);
	let submitError = $state<string | null>(null);
	let submitSuccess = $state<{ action: Action; htmlUrl: string } | null>(null);
	let approveDialogOpen = $state(false);

	/**
	 * Approve click handler. When the walkthrough flagged any issues OR there are
	 * unresolved comment threads, we surface a confirmation dialog so the reviewer
	 * has to explicitly acknowledge they're approving despite outstanding concerns.
	 * With a clean slate we submit directly.
	 */
	function handleApproveClick(): void {
		if (submitting) return;
		if (issues.length > 0 || unresolvedThreads.length > 0) {
			approveDialogOpen = true;
			return;
		}
		void submit('approve');
	}

	const selectedCount = $derived(selectedIssueIds.size);
	const hasContent = $derived(selectedCount > 0 || unresolvedThreads.length > 0);

	const approveBlockerSummary = $derived.by(() => {
		const parts: string[] = [];
		if (issues.length > 0) {
			parts.push(`${issues.length} walkthrough issue${issues.length === 1 ? '' : 's'}`);
		}
		if (unresolvedThreads.length > 0) {
			parts.push(
				`${unresolvedThreads.length} unresolved comment${unresolvedThreads.length === 1 ? '' : 's'}`,
			);
		}
		return parts.join(' and ');
	});

	function severityTag(s: 'info' | 'warning' | 'critical'): string {
		// Plain-text tag used inside the markdown body posted to GitHub.
		// Keeps the comment icon-free per project UI conventions.
		return s === 'critical' ? '`[CRITICAL]`' : s === 'warning' ? '`[WARNING]`' : '`[INFO]`';
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
					`- ${severityTag(issue.severity)} **${issue.title}**${loc}\n  ${issue.description}`,
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
		threadId: string;
	}> {
		const out: Array<{
			path: string;
			body: string;
			line: number;
			side: 'LEFT' | 'RIGHT';
			startLine?: number;
			threadId: string;
		}> = [];

		// Collect IDs of all unresolved threads — these are always included
		const threadIdsToInclude = new Set(unresolvedThreads.map((t) => t.id));

		for (const thread of unresolvedThreads) {
			if (!threadIdsToInclude.has(thread.id)) continue;
			const messages = getThreadMessages(thread.id).filter(
				(m) => m.authorRole === 'reviewer' && m.externalId == null
			);
			const body = messages.map((m) => m.body).filter((b) => b.trim().length > 0).join('\n\n');
			if (!body) continue;
			const comment: {
				path: string;
				body: string;
				line: number;
				side: 'LEFT' | 'RIGHT';
				startLine?: number;
				threadId: string;
			} = {
				path: thread.filePath,
				body,
				line: thread.endLine,
				side: thread.diffSide === 'old' ? 'LEFT' : 'RIGHT',
				threadId: thread.id,
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

		// Capture pending comment count BEFORE the submit (all unresolved threads are included)
		const pendingCount = unresolvedThreads.length;

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

			// Push unsynced replies: messages in synced threads that have no externalId
			const syncedThreads = threads.filter((t) => t.externalCommentId != null);
			const pushTasks = syncedThreads.flatMap((thread) =>
				getThreadMessages(thread.id)
					.filter((msg) => msg.externalId == null && msg.authorRole === 'reviewer')
					.map((msg) =>
						api.api
							.threads({ id: thread.id })
							.messages({ messageId: msg.id })
							.push.post(),
					),
			);
			await Promise.allSettled(pushTasks);

			// Trigger sync-threads to pull back GitHub comment IDs
			await api.api.prs({ id: prId })['sync-threads'].post();

			// Reload session so externalCommentId fields are refreshed locally
			await loadSession(prId);

			const payload = data as { htmlUrl?: string } | null;
			submitSuccess = { action, htmlUrl: payload?.htmlUrl ?? '' };
			const commentSuffix =
				pendingCount > 0
					? ` — ${pendingCount} comment${pendingCount !== 1 ? 's' : ''} posted`
					: '';
			toast.success(actionLabel(action) + ' on GitHub' + commentSuffix);
			// Remember which issues were just submitted so we can mark them as posted
			const merged = new Set([...submittedIssueIds, ...selectedIssueIds]);
			_submittedByPr.set(prId, merged);
		submittedIssueIds = merged;
		selectedIssueIds = new Set();
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
		return 'Changes requested';
	}

	const allIssuesSelected = $derived(
		issues.length > 0 && issues.every((i) => selectedIssueIds.has(i.id))
	);

	function toggleIssue(id: string) {
		if (submittedIssueIds.has(id)) return;
		const next = new Set(selectedIssueIds);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		selectedIssueIds = next;
	}

	function toggleAllIssues() {
		if (allIssuesSelected) {
			selectedIssueIds = new Set();
		} else {
			selectedIssueIds = new Set(issues.filter((i) => !submittedIssueIds.has(i.id)).map((i) => i.id));
		}
	}
</script>

<div class="request-changes">
	<div class="rc-sections">
		<!-- Issues from Walkthrough -->
		<section class="rc-section">
			<div class="rc-section-header">
				<AlertTriangle size={18} />
				<h2 class="rc-section-title">Walkthrough Issues</h2>
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
				<!-- Bucketed by severity (Critical → Warning → Info) so the highest-
				     stakes selections sit at the top of the submit panel. -->
				<div class="rc-issue-groups">
					{#each issueGroups as group (group.severity)}
						<div class="rc-issue-group">
							<div class="rc-issue-group-header rc-issue-group-header--{group.severity}">
								<span class="rc-issue-group-dot"></span>
								<span class="rc-issue-group-label">{group.label}</span>
								<span class="rc-issue-group-count">{group.issues.length}</span>
							</div>
							<div class="rc-list">
								{#each group.issues as { issue, globalIndex } (issue.id)}
									<IssueCard
										{issue}
										checkable
										checked={selectedIssueIds.has(issue.id)}
										disabled={submittedIssueIds.has(issue.id)}
										submitted={submittedIssueIds.has(issue.id)}
										animationDelay="{Math.min(globalIndex, 6) * 50}ms"
										oncheck={() => toggleIssue(issue.id)}
										onfileclick={(filePath, line) => jumpToDiffLine(filePath, line)}
									/>
								{/each}
							</div>
						</div>
					{/each}
				</div>
			{/if}
		</section>

			<!-- Unresolved Comment Threads -->
		<section class="rc-section">
			<div class="rc-section-header">
				<MessageSquare size={18} />
				<h2 class="rc-section-title">Unresolved Comments</h2>
				<span class="rc-badge">{unresolvedThreads.length}</span>
			</div>

			{#if unresolvedThreads.length === 0}
				<div class="rc-empty">No unresolved comment threads</div>
			{:else}
				<ul class="rc-list">
					{#each unresolvedThreads as thread (thread.id)}
						{@const firstMessage = getThreadMessages(thread.id)[0]}
						<li class="rc-item" onclick={() => jumpToDiffLine(thread.filePath, thread.startLine)}>
							<span class="severity-icon severity-thread">
								<MessageSquare size={13} />
							</span>
							<span class="issue-text">
								<div class="issue-location">
									<FileBadge
										filePath={thread.filePath}
										startLine={thread.startLine}
										endLine={thread.endLine}
										onclick={() => jumpToDiffLine(thread.filePath, thread.startLine)}
									/>
								</div>
								{#if firstMessage?.body}
									<p class="thread-preview">{firstMessage.body}</p>
								{/if}
							</span>
						</li>
					{/each}
				</ul>
			{/if}
		</section>
		{#if ratings.length > 0}
			<div class="rc-scorecard">
				<WalkthroughRatingsPanel {ratings} {blocks} onJump={() => {}} />
			</div>
		{/if}
	</div>

	<footer class="rc-footer">
		<div class="rc-actions">
		<span class="wip-btn-wrapper">
			<button
				type="button"
				class="action-btn action-comment"
				disabled
			>
				<Sparkles size={14} />
				Generate changes
			</button>
		</span>
			<button
				type="button"
				class="action-btn action-reject"
				disabled={submitting !== null || !hasContent}
				onclick={() => submit('request_changes')}
				title={!hasContent
					? 'Add comments or select walkthrough issues first'
					: 'Request changes on this pull request'}
			>
				<ArrowUp size={14} />
				{submitting === 'request_changes' ? 'Submitting…' : 'Submit Review'}
			</button>
			<button
				type="button"
				class="action-btn action-approve"
				disabled={submitting !== null}
				onclick={handleApproveClick}
				title={approveBlockerSummary
					? `Approve this pull request — ${approveBlockerSummary} still open`
					: 'Approve this pull request on GitHub'}
			>
				<Check size={14} />
				{submitting === 'approve' ? 'Approving…' : 'Approve'}
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
					? 'Approve directly, or select issues to include in request changes'
					: `${selectedCount} item${selectedCount === 1 ? '' : 's'} selected`}
			</span>
		{/if}
	</footer>
</div>

<ApproveWithIssuesDialog
	bind:open={approveDialogOpen}
	{issues}
	pendingThreads={unresolvedThreads}
	{getThreadMessages}
	onfileclick={(path, line) => jumpToDiffLine(path, line)}
	onconfirm={() => void submit('approve')}
	oncancel={() => {}}
/>

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
		gap: 8px;
		color: var(--color-text-muted);
	}

	.rc-section-title {
		font-size: 18px;
		font-weight: 700;
		color: var(--color-text-primary);
		margin: 0;
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
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.rc-issue-groups {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.rc-issue-group {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.rc-issue-group-header {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--color-text-secondary);
	}

	.rc-issue-group-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--severity-color, var(--color-text-muted));
	}

	.rc-issue-group-label {
		color: var(--severity-color, var(--color-text-secondary));
	}

	.rc-issue-group-count {
		color: var(--color-text-muted);
		font-variant-numeric: tabular-nums;
		font-weight: 500;
	}

	.rc-issue-group-header--critical { --severity-color: var(--color-danger); }
	.rc-issue-group-header--warning { --severity-color: var(--color-warning); }
	.rc-issue-group-header--info { --severity-color: var(--color-accent); }

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

	.wip-btn-wrapper {
		position: relative;
	}

	.wip-btn-wrapper > button {
		width: 100%;
		cursor: not-allowed;
	}

	.wip-btn-wrapper::after {
		content: 'WIP feature';
		position: absolute;
		bottom: calc(100% + 6px);
		left: 50%;
		transform: translateX(-50%);
		background: var(--color-bg-elevated, #1a1a1a);
		color: var(--color-text-primary, #fff);
		font-size: 11px;
		font-weight: 500;
		padding: 4px 8px;
		border-radius: 5px;
		white-space: nowrap;
		pointer-events: none;
		opacity: 0;
		transition: opacity 0.15s ease;
		z-index: 10;
	}

	.wip-btn-wrapper:hover::after {
		opacity: 1;
	}


	/* ── Action buttons — outline→filled pattern via --btn-* variables ── */

	.action-btn {
		--btn-color: var(--color-text-primary);
		--btn-hover-bg: var(--color-bg-secondary);
		--btn-hover-text: var(--color-text-primary);
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
		border: 1px solid var(--btn-color);
		background: transparent;
		color: var(--btn-color);
		cursor: pointer;
		transition:
			background var(--duration-snap),
			border-color var(--duration-snap),
			color var(--duration-snap),
			opacity var(--duration-snap),
			filter var(--duration-snap);
	}

	.action-btn:disabled {
		cursor: not-allowed;
		opacity: 0.4;
	}

	.action-btn:not(:disabled):hover {
		background: var(--btn-hover-bg);
		border-color: var(--btn-color);
		color: var(--btn-hover-text);
		filter: none;
	}

	/* Generate changes — outline that inverts with theme */
	.action-comment:not(:disabled) {
		--btn-color: var(--color-btn-outline);
		--btn-hover-bg: var(--color-btn-outline-fill);
		--btn-hover-text: var(--color-btn-outline-fg);
	}

	/* Approve — success green */
	.action-approve:not(:disabled) {
		--btn-color: var(--color-success);
		--btn-hover-bg: color-mix(in srgb, var(--color-success) 88%, black);
		--btn-hover-text: var(--color-primary-foreground);
	}

	/* Submit Review — accent blue */
	.action-reject:not(:disabled) {
		--btn-color: var(--color-accent);
		--btn-hover-bg: color-mix(in srgb, var(--color-accent) 88%, black);
		--btn-hover-text: var(--color-primary-foreground);
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
		color: var(--color-danger);
	}

	.rc-status-success {
		color: var(--color-success);
	}

	.rc-status a {
		color: inherit;
		text-decoration: underline;
		margin-left: 4px;
	}

	.thread-preview {
		margin: 0;
		font-size: 11px;
		color: var(--color-text-secondary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		max-width: 100%;
	}

	.rc-item {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		padding: 7px 10px;
		border-radius: 6px;
		border: 1px solid var(--color-border);
		background: var(--color-bg-secondary);
		cursor: pointer;
		transition: background var(--duration-snap);
	}

	.rc-item:hover {
		background: var(--color-bg-elevated);
	}

	.severity-icon {
		display: flex;
		align-items: center;
		flex-shrink: 0;
		margin-top: 1px;
	}

	.severity-thread {
		color: var(--color-accent, #2563eb);
	}

	.issue-text {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}

	.issue-location {
		display: flex;
		align-items: center;
	}

	.rc-scorecard {
		padding-bottom: 4px;
		border-bottom: 1px solid var(--color-border);
	}
</style>
