<script lang="ts">
	// One sub-agent invocation. Header shows the sub-agent type + description
	// + status pill. The expanded body shows the sub-agent's own tool calls
	// (passed in by the parent render loop, filtered by subagentInvocationId)
	// followed by the final result text when complete.
	//
	// Default expanded while running so the user can watch progress; default
	// collapsed once completed so a finished invocation stays compact.

	import {
		Bot,
		ChevronDown,
		ChevronRight,
		Loader2,
		CircleCheck,
		CircleX,
	} from '@lucide/svelte';

	import type { ActivityKind } from '@revv/shared';

	interface NestedActivity {
		id: string;
		activityKind: ActivityKind;
		toolName: string;
		summary: string;
	}

	interface Props {
		subagentType: string;
		description: string;
		status: 'running' | 'completed' | 'errored';
		result: string | null;
		activities: ReadonlyArray<NestedActivity>;
	}

	let { subagentType, description, status, result, activities }: Props = $props();

	let userToggled = $state(false);
	let expanded = $state(true);
	$effect(() => {
		if (!userToggled) {
			expanded = status === 'running';
		}
	});

	function toggle(): void {
		userToggled = true;
		expanded = !expanded;
	}
</script>

<div class="subagent" data-status={status}>
	<button class="subagent-header" type="button" onclick={toggle} aria-expanded={expanded}>
		{#if expanded}
			<ChevronDown size={12} class="subagent-chevron" />
		{:else}
			<ChevronRight size={12} class="subagent-chevron" />
		{/if}
		<Bot size={13} class="subagent-icon" />
		<span class="subagent-type">{subagentType}</span>
		<span class="subagent-description">{description}</span>
		<span class="subagent-status">
			{#if status === 'running'}
				<Loader2 size={11} class="motion-essential-spin subagent-running-icon" />
				<span class="subagent-status-label">Running</span>
			{:else if status === 'errored'}
				<CircleX size={11} class="subagent-error-icon" />
				<span class="subagent-status-label">Errored</span>
			{:else}
				<CircleCheck size={11} class="subagent-done-icon" />
				<span class="subagent-status-label">Done</span>
			{/if}
		</span>
	</button>
	{#if expanded}
		<div class="subagent-body">
			{#if activities.length > 0}
				<ul class="subagent-activities">
					{#each activities as activity (activity.id)}
						<li class="subagent-tool-line">
							<span class="subagent-tool-bullet">›</span>
							<span class="subagent-tool-text">{activity.summary}</span>
						</li>
					{/each}
				</ul>
			{/if}
			{#if status !== 'running' && result}
				<div class="subagent-result">
					{result}
				</div>
			{/if}
			{#if status === 'running' && activities.length === 0}
				<p class="subagent-empty">Waiting for the sub-agent to start…</p>
			{/if}
		</div>
	{/if}
</div>

<style>
	.subagent {
		margin: 8px 14px;
		border: 1px solid var(--color-border-subtle);
		border-radius: 8px;
		background: var(--color-bg-secondary);
		overflow: hidden;
	}

	.subagent[data-status='errored'] {
		border-color: color-mix(in srgb, var(--color-danger, #dc2626) 35%, var(--color-border-subtle));
	}

	.subagent-header {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		padding: 8px 12px;
		background: transparent;
		border: none;
		cursor: pointer;
		font-size: 12px;
		text-align: left;
		color: var(--color-text-primary);
		transition: background-color var(--duration-snap) var(--ease-soft);
	}

	.subagent-header:hover {
		background: var(--color-bg-tertiary);
	}

	:global(.subagent-chevron) {
		color: var(--color-text-muted);
	}

	:global(.subagent-icon) {
		color: var(--color-accent);
	}

	.subagent-type {
		font-family: var(--font-mono, ui-monospace, SFMono-Regular, monospace);
		font-size: 11px;
		font-weight: 600;
		color: var(--color-text-primary);
		padding: 1px 6px;
		border-radius: 4px;
		background: var(--color-bg-tertiary);
	}

	.subagent-description {
		flex: 1;
		min-width: 0;
		color: var(--color-text-secondary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.subagent-status {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--color-text-muted);
	}

	:global(.subagent-running-icon) {
		color: var(--color-accent);
	}

	:global(.subagent-done-icon) {
		color: var(--color-success, #16a34a);
	}

	:global(.subagent-error-icon) {
		color: var(--color-danger, #dc2626);
	}

	.subagent-status-label {
		line-height: 1;
	}

	.subagent-body {
		padding: 6px 12px 10px;
		border-top: 1px solid var(--color-border-subtle);
		background: var(--color-bg-primary);
	}

	.subagent-activities {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.subagent-tool-line {
		display: flex;
		align-items: baseline;
		gap: 6px;
		padding: 2px 0;
		font-size: 11px;
		line-height: 1.4;
		color: var(--color-text-secondary);
	}

	.subagent-tool-bullet {
		color: var(--color-text-muted);
		font-weight: 600;
	}

	.subagent-tool-text {
		flex: 1;
		min-width: 0;
		word-break: break-word;
		overflow-wrap: anywhere;
	}

	.subagent-result {
		margin-top: 8px;
		padding: 8px 10px;
		border-radius: 6px;
		background: var(--color-bg-secondary);
		font-size: 12px;
		line-height: 1.5;
		color: var(--color-text-primary);
		white-space: pre-wrap;
		word-break: break-word;
	}

	.subagent-empty {
		margin: 0;
		font-size: 11px;
		font-style: italic;
		color: var(--color-text-muted);
	}
</style>
