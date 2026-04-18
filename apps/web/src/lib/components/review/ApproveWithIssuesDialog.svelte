<script lang="ts">
	import type { CommentThread, WalkthroughIssue } from '@revv/shared';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { AlertTriangle, Info, MessageSquare, XOctagon } from '@lucide/svelte';
	import FileBadge from '$lib/components/ui/FileBadge.svelte';

	interface Props {
		open: boolean;
		issues: WalkthroughIssue[];
		pendingThreads: CommentThread[];
		getThreadMessages?: (threadId: string) => { body: string }[];
		onfileclick?: (filePath: string, line: number) => void;
		onconfirm: () => void;
		oncancel: () => void;
	}

	let {
		open = $bindable(),
		issues,
		pendingThreads,
		getThreadMessages = () => [],
		onfileclick = undefined,
		onconfirm,
		oncancel,
	}: Props = $props();

	const criticalCount = $derived(issues.filter((i) => i.severity === 'critical').length);
	const warningCount = $derived(issues.filter((i) => i.severity === 'warning').length);
	const infoCount = $derived(issues.filter((i) => i.severity === 'info').length);
	const threadCount = $derived(pendingThreads.length);

	const description = $derived.by(() => {
		const parts: string[] = [];
		if (issues.length > 0) {
			parts.push(`${issues.length} walkthrough issue${issues.length === 1 ? '' : 's'}`);
		}
		if (threadCount > 0) {
			parts.push(`${threadCount} unresolved comment${threadCount === 1 ? '' : 's'}`);
		}
		const joined =
			parts.length === 2 ? `${parts[0]} and ${parts[1]}` : (parts[0] ?? '');
		return `${joined} still open on this pull request. Approving will submit your approval to GitHub without resolving them.`;
	});

	function handleFileClick(filePath: string, line: number): void {
		open = false;
		onfileclick?.(filePath, line);
	}

	function handleConfirm(): void {
		onconfirm();
		open = false;
	}

	function handleCancel(): void {
		oncancel();
		open = false;
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Portal>
		<Dialog.Overlay />
		<Dialog.Content class="approve-warn-dialog-content">
			<Dialog.Header>
				<Dialog.Title>
					<span class="title-with-icon">
						<AlertTriangle size={18} />
						Approve with unresolved items?
					</span>
				</Dialog.Title>
				<Dialog.Description>{description}</Dialog.Description>
			</Dialog.Header>

		<div class="issue-summary">
			{#if criticalCount > 0}
				<span class="count-pill count-critical">
					<XOctagon size={12} />
					{criticalCount} critical
				</span>
			{/if}
			{#if warningCount > 0}
				<span class="count-pill count-warning">
					<AlertTriangle size={12} />
					{warningCount} warning{warningCount !== 1 ? 's' : ''}
				</span>
			{/if}
			{#if infoCount > 0}
				<span class="count-pill count-info">
					<Info size={12} />
					{infoCount} info
				</span>
			{/if}
			{#if threadCount > 0}
				<span class="count-pill count-thread">
					<MessageSquare size={12} />
					{threadCount} comment{threadCount !== 1 ? 's' : ''}
				</span>
			{/if}
		</div>

		{#if issues.length > 0}
			<div class="section">
				<div class="section-label">Walkthrough issues</div>
				<ul class="issue-list">
					{#each issues as issue (issue.id)}
						<li class="issue-row">
							<span class="severity-icon severity-{issue.severity}">
								{#if issue.severity === 'critical'}
									<XOctagon size={13} />
								{:else if issue.severity === 'warning'}
									<AlertTriangle size={13} />
								{:else}
									<Info size={13} />
								{/if}
							</span>
							<span class="issue-text">
								<span class="issue-title">{issue.title}</span>
							{#if issue.filePath}
								<div class="issue-location">
									<FileBadge
										filePath={issue.filePath}
										onclick={issue.filePath ? () => handleFileClick(issue.filePath!, issue.startLine ?? 1) : undefined}
									/>
								</div>
							{/if}
							</span>
						</li>
					{/each}
				</ul>
			</div>
		{/if}

		{#if threadCount > 0}
			<div class="section">
				<div class="section-label">Unresolved comments</div>
				<ul class="issue-list">
					{#each pendingThreads as thread (thread.id)}
						{@const firstMessage = getThreadMessages(thread.id)[0]}
						<li class="issue-row">
							<span class="severity-icon severity-thread">
								<MessageSquare size={13} />
							</span>
                <span class="issue-text">
                    <div class="issue-location">
                        <FileBadge filePath={thread.filePath} startLine={thread.startLine} endLine={thread.endLine} onclick={() => handleFileClick(thread.filePath, thread.startLine)} />
                    </div>
                    {#if firstMessage?.body}
                        <p class="thread-preview">{firstMessage.body}</p>
                    {/if}
                </span>
						</li>
					{/each}
				</ul>
			</div>
		{/if}

			<div class="dialog-actions">
				<Button variant="outline" size="sm" class="pill-button" onclick={handleCancel}>Cancel</Button>
				<Button variant="destructive" size="sm" class="pill-button" onclick={handleConfirm}>Approve anyway</Button>
			</div>
		</Dialog.Content>
	</Dialog.Portal>
</Dialog.Root>

<style>
	:global(.approve-warn-dialog-content) {
		max-width: 480px !important;
		width: 100%;
		overflow-y: auto;
		overflow-x: hidden;
		max-height: 60vh;
	}

	.title-with-icon {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		color: var(--color-warning, #d97706);
	}

	.issue-summary {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin: 12px 0 0;
	}

	.count-pill {
		--pill-color: var(--color-text-muted);
		display: inline-flex;
		align-items: center;
		gap: 4px;
		border-radius: 999px;
		padding: 2px 8px;
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.02em;
		background: color-mix(in srgb, var(--pill-color) 15%, transparent);
		color: var(--pill-color);
		border: 1px solid color-mix(in srgb, var(--pill-color) 30%, transparent);
	}

	.count-critical {
		--pill-color: var(--color-danger, #dc2626);
	}
	.count-warning {
		--pill-color: #d97706;
	}
	.count-info {
		--pill-color: var(--color-text-muted);
	}
	.count-thread {
		--pill-color: var(--color-accent, #2563eb);
	}

	.section {
		margin: 12px 0 0;
		min-width: 0;
	}

	.section-label {
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--color-text-muted);
		margin-bottom: 6px;
	}

	.issue-list {
		list-style: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 4px;
		width: 100%;
		min-width: 0;
	}

	.issue-row {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		padding: 7px 10px;
		border-radius: 6px;
		border: 1px solid var(--color-border);
		background: var(--color-bg-secondary);
		width: 100%;
		box-sizing: border-box;
		min-width: 0;
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
		flex: 1;
		overflow: hidden;
	}

	.issue-location {
		display: flex;
		align-items: center;
		overflow: hidden;
		max-width: 100%;
	}

	.thread-preview {
		display: block;
		max-width: 100%;
		font-size: 12px;
		color: var(--color-text-secondary);
		margin: 0;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.dialog-actions {
		display: flex;
		flex-direction: column-reverse;
		gap: 8px;
		margin-top: 4px;
	}

	.severity-critical { color: var(--color-danger, #dc2626); }
	.severity-warning { color: #d97706; }
	.severity-info { color: var(--color-accent, #2563eb); }

	.issue-title {
		font-size: 12px;
		font-weight: 500;
		color: var(--color-text-primary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	@media (min-width: 640px) {
	.dialog-actions {
			flex-direction: row;
			justify-content: flex-end;
		}
	}

	:global(.approve-warn-dialog-content .pill-button) {
		border-radius: 100px;
	}
</style>
