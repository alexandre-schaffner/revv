<script lang="ts">
	import type { WalkthroughIssue } from '@revv/shared';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { AlertTriangle, Info, XOctagon } from '@lucide/svelte';
	import { SvelteSet } from 'svelte/reactivity';

	interface Props {
		open: boolean;
		issues: WalkthroughIssue[];
		onconfirm: (keptIssues: WalkthroughIssue[]) => void;
		oncancel: () => void;
	}

	let { open = $bindable(), issues, onconfirm, oncancel }: Props = $props();

	// All checked by default; reset whenever the dialog opens
	const checked = new SvelteSet<string>();

	$effect(() => {
		if (open) {
			checked.clear();
			for (const issue of issues) {
				checked.add(issue.id);
			}
		}
	});

	const allChecked = $derived(checked.size === issues.length);

	function toggle(id: string): void {
		if (checked.has(id)) {
			checked.delete(id);
		} else {
			checked.add(id);
		}
	}

	function toggleAll(): void {
		if (allChecked) {
			checked.clear();
		} else {
			for (const issue of issues) {
				checked.add(issue.id);
			}
		}
	}

	function handleConfirm(): void {
		const kept = issues.filter((i) => checked.has(i.id));
		onconfirm(kept);
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
		<Dialog.Content class="regen-dialog-content">
			<Dialog.Header>
				<Dialog.Title>Regenerate walkthrough</Dialog.Title>
				<Dialog.Description>
					{issues.length} issue{issues.length !== 1 ? 's' : ''} were flagged in this walkthrough.
					Select which ones to carry over so the AI can address them in the new generation.
				</Dialog.Description>
			</Dialog.Header>

			<div class="issue-list-wrap">
				{#if issues.length > 1}
					<button type="button" class="toggle-all-btn" onclick={toggleAll}>
						{allChecked ? 'Deselect all' : 'Select all'}
					</button>
				{/if}
				<ul class="issue-list">
					{#each issues as issue (issue.id)}
						<li class="issue-row">
							<label class="issue-label">
								<input
									type="checkbox"
									class="issue-checkbox"
									checked={checked.has(issue.id)}
									onchange={() => toggle(issue.id)}
								/>
								<span class="severity-icon severity-{issue.severity}">
									{#if issue.severity === 'info'}
										<Info size={13} />
									{:else if issue.severity === 'warning'}
										<AlertTriangle size={13} />
									{:else}
										<XOctagon size={13} />
									{/if}
								</span>
								<span class="issue-text">
									<span class="issue-title">{issue.title}</span>
									{#if issue.filePath}
										<span class="issue-location">
											{issue.filePath}{issue.startLine != null ? `:${issue.startLine}` : ''}
										</span>
									{/if}
								</span>
							</label>
						</li>
					{/each}
				</ul>
			</div>

			<Dialog.Footer>
				<Button variant="outline" size="sm" onclick={handleCancel}>Cancel</Button>
				<Button size="sm" onclick={handleConfirm}>Regenerate</Button>
			</Dialog.Footer>
		</Dialog.Content>
	</Dialog.Portal>
</Dialog.Root>

<style>
	:global(.regen-dialog-content) {
		max-width: 480px !important;
		width: 100%;
	}

	.issue-list-wrap {
		display: flex;
		flex-direction: column;
		gap: 6px;
		margin: 12px 0;
	}

	.toggle-all-btn {
		align-self: flex-end;
		background: none;
		border: none;
		padding: 0;
		font-size: 11px;
		font-weight: 500;
		color: var(--color-text-muted);
		cursor: pointer;
		text-decoration: underline;
		text-underline-offset: 2px;
	}

	.toggle-all-btn:hover {
		color: var(--color-text-secondary);
	}

	.issue-list {
		list-style: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 4px;
		max-height: 320px;
		overflow-y: auto;
	}

	.issue-row {
		display: flex;
	}

	.issue-label {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		width: 100%;
		padding: 7px 10px;
		border-radius: 6px;
		border: 1px solid var(--color-border);
		background: var(--color-bg-secondary);
		cursor: pointer;
		transition: background-color 100ms ease;
	}

	.issue-label:hover {
		background: var(--color-bg-tertiary);
	}

	.issue-checkbox {
		margin-top: 1px;
		flex-shrink: 0;
		cursor: pointer;
		accent-color: var(--color-accent);
	}

	.severity-icon {
		display: flex;
		align-items: center;
		flex-shrink: 0;
		margin-top: 1px;
	}

	.severity-info {
		color: var(--color-text-muted);
	}

	.severity-warning {
		color: #d97706;
	}

	.severity-critical {
		color: var(--color-danger, #dc2626);
	}

	.issue-text {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}

	.issue-title {
		font-size: 13px;
		font-weight: 500;
		color: var(--color-text-primary);
		line-height: 1.4;
	}

	.issue-location {
		font-size: 11px;
		font-family: var(--font-mono, monospace);
		color: var(--color-text-muted);
		opacity: 0.8;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
