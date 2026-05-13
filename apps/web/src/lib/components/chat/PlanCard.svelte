<script lang="ts">
	// One plan presented by the agent. When pending, footer shows Reject /
	// Approve & continue actions. After a decision, the footer collapses to
	// a small status badge. The markdown body is rendered with the shared
	// markdown helper so plans get the same formatting as assistant bubbles.

	import { Check, X, Lightbulb, CircleCheck, CircleX } from '@lucide/svelte';
	import { renderMarkdown } from '$lib/utils/markdown';
	import { Button } from '$lib/components/ui/button';

	interface Props {
		planId: string;
		markdown: string;
		status: 'pending' | 'approved' | 'rejected' | 'superseded';
		onApprove: () => void;
		onReject: () => void;
		disabled?: boolean;
	}

	let { planId: _planId, markdown, status, onApprove, onReject, disabled = false }: Props = $props();

	const html = $derived(markdown ? renderMarkdown(markdown) : '');
</script>

<div class="plan-card" data-status={status}>
	<div class="plan-card-header">
		<Lightbulb size={14} class="plan-card-icon" />
		<span class="plan-card-title">Plan</span>
		{#if status === 'approved'}
			<span class="plan-card-badge plan-card-badge--approved">
				<CircleCheck size={11} />
				Approved
			</span>
		{:else if status === 'rejected'}
			<span class="plan-card-badge plan-card-badge--rejected">
				<CircleX size={11} />
				Rejected
			</span>
		{:else if status === 'superseded'}
			<span class="plan-card-badge">Superseded</span>
		{/if}
	</div>
	<div class="plan-card-body">
		{@html html}
	</div>
	{#if status === 'pending'}
		<div class="plan-card-footer">
			<Button
				variant="outline"
				size="sm"
				onclick={() => onReject()}
				disabled={disabled}
			>
				<X size={12} />
				Reject
			</Button>
			<Button
				variant="default"
				size="sm"
				onclick={() => onApprove()}
				disabled={disabled}
			>
				<Check size={12} />
				Approve &amp; continue
			</Button>
		</div>
	{/if}
</div>

<style>
	.plan-card {
		margin: 10px 14px;
		border: 1px solid var(--color-border-subtle);
		border-radius: 10px;
		background: var(--color-bg-secondary);
		overflow: hidden;
	}

	.plan-card[data-status='approved'] {
		border-color: color-mix(in srgb, var(--color-success, #16a34a) 35%, var(--color-border-subtle));
	}

	.plan-card[data-status='rejected'] {
		border-color: color-mix(in srgb, var(--color-danger, #dc2626) 35%, var(--color-border-subtle));
		opacity: 0.85;
	}

	.plan-card-header {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 10px 14px;
		border-bottom: 1px solid var(--color-border-subtle);
		background: var(--color-bg-tertiary);
	}

	:global(.plan-card-icon) {
		color: var(--color-accent);
	}

	.plan-card-title {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--color-text-primary);
	}

	.plan-card-badge {
		margin-left: auto;
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 2px 8px;
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		border-radius: 999px;
		background: var(--color-bg-primary);
		color: var(--color-text-muted);
	}

	.plan-card-badge--approved {
		background: color-mix(in srgb, var(--color-success, #16a34a) 16%, transparent);
		color: var(--color-success, #16a34a);
	}

	.plan-card-badge--rejected {
		background: color-mix(in srgb, var(--color-danger, #dc2626) 16%, transparent);
		color: var(--color-danger, #dc2626);
	}

	.plan-card-body {
		padding: 12px 14px;
		font-size: 13px;
		line-height: 1.6;
		color: var(--color-text-primary);
	}

	.plan-card-body :global(p),
	.plan-card-body :global(ul),
	.plan-card-body :global(ol),
	.plan-card-body :global(pre) {
		margin: 0 0 8px;
	}

	.plan-card-body :global(p:last-child),
	.plan-card-body :global(ul:last-child),
	.plan-card-body :global(ol:last-child),
	.plan-card-body :global(pre:last-child) {
		margin-bottom: 0;
	}

	.plan-card-body :global(code) {
		font-size: 0.92em;
		padding: 0 4px;
		border-radius: 4px;
		background: var(--color-bg-tertiary);
	}

	.plan-card-body :global(pre) {
		padding: 8px 10px;
		border-radius: 6px;
		background: var(--color-bg-tertiary);
		overflow-x: auto;
	}

	.plan-card-footer {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		padding: 10px 14px;
		border-top: 1px solid var(--color-border-subtle);
		background: var(--color-bg-primary);
	}
</style>
