<script lang="ts">
	import { getIssues, getRatings, getBlocks } from '$lib/stores/walkthrough.svelte';
	import {
		getThreads,
		getThreadMessages,
		loadSession,
		jumpToDiffLine,
		jumpToWalkthroughBlock,
	} from '$lib/stores/review.svelte';
	import { api } from '$lib/api/client';
	import { toast } from 'svelte-sonner';
	import { Check, ArrowUp, Sparkles } from '@lucide/svelte';
	import WalkthroughRatingsPanel from '$lib/components/walkthrough/WalkthroughRatingsPanel.svelte';
	import IssuesPanel from './issues-panel/IssuesPanel.svelte';
	import CommentsPanel from './comments-panel/CommentsPanel.svelte';
	import ApproveWithIssuesDialog from './ApproveWithIssuesDialog.svelte';

	// Module-level: survives component remount, keyed by PR ID
	const _submittedByPr = new Map<string, Set<string>>();

	interface Props {
		prId: string;
	}
	let { prId }: Props = $props();

	type Action = 'approve' | 'request_changes';

	const issues = $derived(getIssues());
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
	const hasContent = $derived(selectedCount > 0);

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

		// Collect IDs of all unresolved threads
		for (const thread of unresolvedThreads) {
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
			toast.success(actionLabel(action) + ' on GitHub');
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
		<IssuesPanel
			{issues}
			selectedIds={selectedIssueIds}
			submittedIds={submittedIssueIds}
			onToggleSelect={toggleIssue}
			onToggleSelectAll={toggleAllIssues}
			onFileClick={jumpToDiffLine}
			{blocks}
			onBlockJump={jumpToWalkthroughBlock}
		/>

		<CommentsPanel
			threads={unresolvedThreads}
			{getThreadMessages}
			onJump={jumpToDiffLine}
		/>

		{#if ratings.length > 0}
			<div class="rc-scorecard">
				<WalkthroughRatingsPanel {ratings} {blocks} onJump={jumpToWalkthroughBlock} />
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
					? 'Approve directly, or select walkthrough issues to include in request changes'
					: `${selectedCount} issue${selectedCount === 1 ? '' : 's'} selected`}
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

	/* Both sections and footer use the SAME asymmetric 6-col grid as
	   `.walkthrough-content` and `.page-title-section--narrow`, so the
	   Request Changes tab aligns horizontally with the content column
	   (col 3, 820 wide) above. No annotation rail here — Request Changes
	   has no per-block commentary — but we still use the full 6-col grid
	   so the content column lands at the same viewport position as in
	   the walkthrough tab. A plain `max-width: 900; margin-inline: auto`
	   would center in the viewport, but col 3 of the asymmetric grid is
	   shifted ~210px right of viewport center, so viewport-centering
	   would misalign with the title above. */
	.rc-sections {
		display: grid;
		grid-template-columns:
			420px
			minmax(0, 1fr)
			minmax(0, 820px)
			40px
			380px
			minmax(0, 1fr);
		padding: 16px 0;
		row-gap: 20px;
	}

	/* Inner sections land in col 3 (820 content column). */
	.rc-sections > :global(*) {
		grid-column: 3;
	}

	/* Footer — same grid. The border-top spans only col 3 (same width as
	   the content above), which reads as a natural continuation of the
	   centered column rather than a full-width divider slicing the page. */
	.rc-footer {
		flex-shrink: 0;
		display: grid;
		grid-template-columns:
			420px
			minmax(0, 1fr)
			minmax(0, 820px)
			40px
			380px
			minmax(0, 1fr);
		padding: 16px 0 20px;
		row-gap: 8px;
	}

	.rc-footer > * {
		grid-column: 3;
	}

	/* The border-top should sit inside col 3 so it lines up with the
	   content width. Apply it to a ::before pseudo-element on the footer
	   spanning col 3. */
	.rc-footer::before {
		content: '';
		grid-column: 3;
		border-top: 1px solid var(--color-border);
		/* Zero-height pseudo that carries only the border, placed as the
		   first grid item so everything after flows below it. */
		height: 0;
	}

	/* Narrow-viewport fallback — matches the GuidedWalkthrough breakpoint
	   so all three containers (walkthrough, title, request-changes) collapse
	   at the same viewport width. */
	@media (max-width: 1700px) {
		.rc-sections,
		.rc-footer {
			display: block;
			max-width: 860px;
			padding-left: 32px;
			padding-right: 32px;
			margin-inline: auto;
			box-sizing: border-box;
		}

		.rc-sections {
			padding-top: 16px;
			padding-bottom: 16px;
			display: flex;
			flex-direction: column;
			gap: 20px;
		}

		.rc-footer {
			padding-top: 16px;
			padding-bottom: 20px;
			display: flex;
			flex-direction: column;
			gap: 8px;
			border-top: 1px solid var(--color-border);
		}

		.rc-footer::before {
			display: none;
		}

		.rc-sections > :global(*),
		.rc-footer > * {
			grid-column: auto;
		}
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

	/* .rc-scorecard is a plain wrapper — no section header here. The scorecard
	   renders its own internal summary bar, so a wrapping section header would
	   be redundant. Separation from siblings is handled by the 20px gap on
	   .rc-sections. */
</style>
