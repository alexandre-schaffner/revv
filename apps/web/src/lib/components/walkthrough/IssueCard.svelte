<script lang="ts">
	import type { WalkthroughIssue } from '@revv/shared';
	import FileBadge from '$lib/components/ui/FileBadge.svelte';

	interface Props {
		issue: WalkthroughIssue;
		clickable?: boolean;
		onclick?: () => void;
		checkable?: boolean;
		checked?: boolean;
		disabled?: boolean;
		oncheck?: (checked: boolean) => void;
		submitted?: boolean;
		animationDelay?: string;
		onfileclick?: (filePath: string, line: number) => void;
		stepTag?: string | null;
		hideFileBadge?: boolean;
	}

	let {
		issue,
		clickable = false,
		onclick,
		checkable = false,
		checked = false,
		disabled = false,
		oncheck,
		submitted = false,
		animationDelay = '0ms',
		onfileclick,
		stepTag = null,
		hideFileBadge = false,
	}: Props = $props();

	const severityLabels: Record<string, string> = {
		info: 'Info',
		warning: 'Warning',
		critical: 'Critical',
	};
</script>

{#if clickable}
	<button
		type="button"
		class="issue-card issue-card--{issue.severity}"
		class:issue-card--submitted={submitted}
		style:--issue-delay={animationDelay}
		{onclick}
	>
		{@render cardContent()}
	</button>
{:else if checkable}
	<label
		class="issue-card issue-card--{issue.severity}"
		class:issue-card--submitted={submitted}
		class:issue-card--checked={checked}
		style:--issue-delay={animationDelay}
	>
		{@render cardContent()}
	</label>
{:else}
	<div
		class="issue-card issue-card--{issue.severity}"
		class:issue-card--submitted={submitted}
		style:--issue-delay={animationDelay}
	>
		{@render cardContent()}
	</div>
{/if}

{#snippet cardContent()}
	{#if checkable}
		<input
			type="checkbox"
			class="issue-card-checkbox"
			{checked}
			{disabled}
			onchange={(e) => oncheck?.(e.currentTarget.checked)}
		/>
	{/if}
	<div class="issue-card-body">
		<div class="issue-card-top">
			<span class="issue-badge issue-badge--{issue.severity}">
				{severityLabels[issue.severity] ?? issue.severity}
			</span>
			{#if submitted}
				<span class="issue-card-posted-badge">Posted</span>
			{/if}
			<span class="issue-card-title">{issue.title}</span>
			{#if stepTag}
				<span class="issue-step-tag">{stepTag}</span>
			{/if}
		</div>
		{#if issue.filePath && !hideFileBadge}
			<div
				class="issue-card-location"
				onclick={(e) => e.stopPropagation()}
				role="presentation"
			>
				<FileBadge
					filePath={issue.filePath}
					startLine={issue.startLine}
					endLine={issue.endLine}
					onclick={onfileclick ? () => onfileclick!(issue.filePath!, issue.startLine ?? 1) : undefined}
				/>
			</div>
		{/if}
		<p class="issue-card-description">{issue.description}</p>
	</div>
{/snippet}

<style>
	/* ── Base card ──────────────────────────────────────────────────── */
	.issue-card {
		padding: 10px 14px;
		border-radius: 8px;
		background: var(--color-bg-secondary);
		border: 1px solid var(--color-border);
		border-left: 3px solid var(--severity-color, var(--color-border));
		display: flex;
		flex-direction: row;
		align-items: flex-start;
		gap: 10px;
		animation: issue-card-enter 0.55s cubic-bezier(0.22, 0.61, 0.36, 1) both;
		animation-delay: var(--issue-delay, 0ms);
		text-align: left;
		font: inherit;
		color: inherit;
		width: 100%;
		box-sizing: border-box;
		cursor: default;
	}

	/* Severity left-border + hover shadow color */
	.issue-card--info {
		--severity-color: var(--color-accent);
		background: color-mix(in srgb, var(--color-accent) 4%, var(--color-bg-secondary));
	}
	.issue-card--warning {
		--severity-color: var(--color-warning);
		background: color-mix(in srgb, var(--color-warning) 4%, var(--color-bg-secondary));
	}
	.issue-card--critical {
		--severity-color: var(--color-danger);
		background: color-mix(in srgb, var(--color-danger) 4%, var(--color-bg-secondary));
	}

	/* ── Clickable (button) variant ─────────────────────────────────── */
	button.issue-card {
		cursor: pointer;
		transition:
			transform 120ms ease,
			border-color 120ms ease,
			box-shadow 120ms ease;
	}

	button.issue-card:hover {
		transform: translateY(-1px);
		border-color: color-mix(in srgb, var(--severity-color, var(--color-accent)) 50%, var(--color-border));
		box-shadow: 0 2px 8px color-mix(in srgb, var(--severity-color, var(--color-text-primary)) 12%, transparent);
	}

	button.issue-card:hover .issue-step-tag {
		color: var(--color-accent);
	}

	button.issue-card:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: 2px;
	}

	/* ── Checkable (label) variant ──────────────────────────────────── */
	label.issue-card {
		cursor: pointer;
		transition:
			border-color 120ms ease,
			background 120ms ease;
	}

	.issue-card--checked {
		border-color: color-mix(in srgb, var(--color-accent) 55%, transparent);
		background: color-mix(in srgb, var(--color-accent) 6%, var(--color-bg-secondary));
	}

	/* When severity AND checked, blend both bg tints */
	.issue-card--info.issue-card--checked {
		background: color-mix(
			in srgb,
			var(--color-accent) 8%,
			color-mix(in srgb, var(--color-accent) 4%, var(--color-bg-secondary))
		);
	}
	.issue-card--warning.issue-card--checked {
		background: color-mix(
			in srgb,
			var(--color-accent) 6%,
			color-mix(in srgb, var(--color-warning) 4%, var(--color-bg-secondary))
		);
	}
	.issue-card--critical.issue-card--checked {
		background: color-mix(
			in srgb,
			var(--color-accent) 6%,
			color-mix(in srgb, var(--color-danger) 4%, var(--color-bg-secondary))
		);
	}

	/* ── Submitted state ─────────────────────────────────────────────── */
	.issue-card--submitted {
		opacity: 0.55;
	}

	.issue-card--submitted .issue-card-checkbox {
		cursor: not-allowed;
	}

	/* ── Checkbox ────────────────────────────────────────────────────── */
	.issue-card-checkbox {
		margin-top: 2px;
		width: 14px;
		height: 14px;
		accent-color: var(--color-accent);
		cursor: pointer;
		flex-shrink: 0;
	}

	/* ── Body ────────────────────────────────────────────────────────── */
	.issue-card-body {
		display: flex;
		flex-direction: column;
		gap: 4px;
		flex: 1;
		min-width: 0;
	}

	.issue-card-top {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}

	.issue-card-title {
		font-size: 13px;
		font-weight: 500;
		color: var(--color-text-primary);
		line-height: 1.4;
	}

	.issue-card-description {
		font-size: 12px;
		color: var(--color-text-secondary);
		line-height: 1.5;
		margin: 0;
	}

	.issue-card-location {
		display: flex;
		align-items: center;
		gap: 2px;
		font-family: var(--font-mono, monospace);
	}

	/* ── Step tag ────────────────────────────────────────────────────── */
	.issue-step-tag {
		margin-left: auto;
		font-size: 10px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--color-text-muted);
		padding: 1px 6px;
		border-radius: 9999px;
		background: var(--color-bg-tertiary);
		flex-shrink: 0;
		transition: color 120ms ease;
	}

	/* ── Posted badge ─────────────────────────────────────────────────── */
	.issue-card-posted-badge {
		display: inline-flex;
		align-items: center;
		border-radius: 9999px;
		padding: 1px 7px;
		font-size: 10px;
		font-weight: 700;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		flex-shrink: 0;
		background: color-mix(in srgb, var(--color-success) 15%, transparent);
		color: var(--color-success);
		border: 1px solid color-mix(in srgb, var(--color-success) 30%, transparent);
	}

	/* ── Severity badge ──────────────────────────────────────────────── */
	.issue-badge {
		font-size: 10px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		padding: 1px 7px;
		border-radius: 9999px;
		border: 1px solid transparent;
		flex-shrink: 0;
	}

	.issue-badge--info {
		background: color-mix(in srgb, var(--color-accent) 12%, transparent);
		color: var(--color-accent-hover);
		border-color: color-mix(in srgb, var(--color-accent) 30%, transparent);
	}

	.issue-badge--warning {
		background: color-mix(in srgb, var(--color-warning) 12%, transparent);
		color: var(--color-warning);
		border-color: color-mix(in srgb, var(--color-warning) 30%, transparent);
	}

	.issue-badge--critical {
		background: color-mix(in srgb, var(--color-danger) 12%, transparent);
		color: var(--color-danger);
		border-color: color-mix(in srgb, var(--color-danger) 30%, transparent);
	}

	/* ── Animation ───────────────────────────────────────────────────── */
	@keyframes issue-card-enter {
		from {
			opacity: 0;
			transform: translateY(4px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.issue-card {
			animation-duration: 0.01ms !important;
			animation-delay: 0ms !important;
		}
		button.issue-card,
		label.issue-card {
			transition: none !important;
		}
		button.issue-card:hover {
			transform: none;
		}
	}
</style>
