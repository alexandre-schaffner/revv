<script lang="ts">
	// Agent task list rendered inline in the chat panel. Sourced from the
	// agent's TodoWrite tool (Claude) or the daemon-maintained todos surfaced
	// via `todo.updated` SSE (opencode). Snapshot semantics — each update
	// replaces the full list for a turn.
	//
	// Default collapsed once every task is completed (the panel stays compact
	// for finished work but expands automatically when there's something in
	// progress). The header always shows the in-progress / total counts.

	import {
		ChevronDown,
		ChevronRight,
		CheckCircle2,
		Circle,
		Loader2,
		ListTodo,
	} from '@lucide/svelte';
	import type { ChatTask } from '@revv/shared';

	interface Props {
		tasks: ReadonlyArray<ChatTask>;
	}

	let { tasks }: Props = $props();

	const total = $derived(tasks.length);
	const completed = $derived(tasks.filter((t) => t.status === 'completed').length);
	const inProgress = $derived(tasks.filter((t) => t.status === 'in_progress').length);
	const allDone = $derived(total > 0 && completed === total);

	// Default collapsed only when everything is done. Otherwise expanded so
	// the active task is always visible without a click.
	let userToggled = $state(false);
	let expanded = $state(true);
	$effect(() => {
		if (!userToggled) {
			expanded = !allDone;
		}
	});

	function toggle(): void {
		userToggled = true;
		expanded = !expanded;
	}
</script>

<div class="task-list" class:task-list--done={allDone}>
	<button class="task-list-header" type="button" onclick={toggle} aria-expanded={expanded}>
		{#if expanded}
			<ChevronDown size={12} class="task-list-chevron" />
		{:else}
			<ChevronRight size={12} class="task-list-chevron" />
		{/if}
		<ListTodo size={12} class="task-list-icon" />
		<span class="task-list-title">Tasks</span>
		<span class="task-list-counts">
			{#if inProgress > 0}
				<span class="task-list-active">{inProgress} in progress</span>
				<span class="task-list-sep">·</span>
			{/if}
			<span class="task-list-progress">{completed}/{total}</span>
		</span>
	</button>
	{#if expanded}
		<ul class="task-list-items">
			{#each tasks as task (task.id)}
				<li class="task-list-item" class:task-list-item--done={task.status === 'completed'}>
					{#if task.status === 'completed'}
						<CheckCircle2 size={12} class="task-list-item-icon task-list-item-icon--done" />
					{:else if task.status === 'in_progress'}
						<Loader2 size={12} class="task-list-item-icon task-list-item-icon--running motion-essential-spin" />
					{:else}
						<Circle size={12} class="task-list-item-icon" />
					{/if}
					<span class="task-list-item-text">
						{#if task.status === 'in_progress' && task.activeForm}
							{task.activeForm}
						{:else}
							{task.content}
						{/if}
					</span>
				</li>
			{/each}
		</ul>
	{/if}
</div>

<style>
	.task-list {
		margin: 8px 14px;
		border: 1px solid var(--color-border-subtle);
		border-radius: 8px;
		background: var(--color-bg-secondary);
		overflow: hidden;
	}

	.task-list--done {
		opacity: 0.7;
	}

	.task-list-header {
		display: flex;
		align-items: center;
		gap: 6px;
		width: 100%;
		padding: 8px 12px;
		background: transparent;
		border: none;
		cursor: pointer;
		font-size: 11px;
		color: var(--color-text-secondary);
		text-align: left;
		transition: background-color var(--duration-snap) var(--ease-soft);
	}

	.task-list-header:hover {
		background: var(--color-bg-tertiary);
	}

	:global(.task-list-chevron) {
		color: var(--color-text-muted);
	}

	:global(.task-list-icon) {
		color: var(--color-text-muted);
	}

	.task-list-title {
		font-weight: 600;
		letter-spacing: 0.02em;
		color: var(--color-text-primary);
	}

	.task-list-counts {
		margin-left: auto;
		display: inline-flex;
		gap: 6px;
		font-variant-numeric: tabular-nums;
		color: var(--color-text-muted);
	}

	.task-list-active {
		color: var(--color-accent);
		font-weight: 500;
	}

	.task-list-sep {
		opacity: 0.5;
	}

	.task-list-items {
		list-style: none;
		margin: 0;
		padding: 0 12px 8px;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.task-list-item {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		padding: 4px 4px;
		font-size: 12px;
		line-height: 1.5;
		color: var(--color-text-primary);
	}

	.task-list-item--done .task-list-item-text {
		text-decoration: line-through;
		color: var(--color-text-muted);
	}

	:global(.task-list-item-icon) {
		flex-shrink: 0;
		margin-top: 3px;
		color: var(--color-text-muted);
	}

	:global(.task-list-item-icon--done) {
		color: var(--color-success, #16a34a);
	}

	:global(.task-list-item-icon--running) {
		color: var(--color-accent);
	}

	.task-list-item-text {
		flex: 1;
		min-width: 0;
		word-wrap: break-word;
		overflow-wrap: anywhere;
	}
</style>
