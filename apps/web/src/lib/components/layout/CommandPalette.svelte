<script lang="ts">
	import { untrack } from 'svelte';
	import { fade, scale } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import { Search } from '@lucide/svelte';
	import { getPullRequests, getRepositories, selectPr } from '$lib/stores/prs.svelte';
	import { getFilteredCommands, setQuery as setCommandQuery, resetQuery, fuzzyScore } from '$lib/stores/commands.svelte';
	import { setPaletteMode, closePalette, type PaletteMode } from '$lib/stores/shortcuts.svelte';
	import type { PullRequest, Repository } from '@revv/shared';

	interface Props {
		open: boolean;
		mode: PaletteMode;
		onClose: () => void;
	}

	let { open, mode, onClose }: Props = $props();

	let inputValue = $state('');
	let selectedIndex = $state(0);
	let inputEl: HTMLInputElement | undefined = $state();
	let listEl: HTMLDivElement | undefined = $state();

	// ── Mode switching via `>` prefix ────────────────────

	function handleInput(e: Event) {
		const val = (e.target as HTMLInputElement).value;
		inputValue = val;

		if (mode === 'search' && val.startsWith('>')) {
			setPaletteMode('command');
			setCommandQuery(val.slice(1).trim());
		} else if (mode === 'command' && !val.startsWith('>')) {
			setPaletteMode('search');
			setCommandQuery('');
		} else if (mode === 'command') {
			setCommandQuery(val.slice(1).trim());
		}
	}

	// ── PR search ────────────────────────────────────────

	const repoMap = $derived(
		new Map<string, Repository>(getRepositories().map((r) => [r.id, r]))
	);

	interface PrResult {
		pr: PullRequest;
		repoName: string;
		score: number;
	}

	const prResults = $derived.by((): PrResult[] => {
		if (mode !== 'search') return [];

		const prs = getPullRequests();
		const q = inputValue.trim();

		if (q.length === 0) {
			return prs.map((pr) => ({
				pr,
				repoName: repoMap.get(pr.repositoryId)?.fullName ?? '',
				score: 0,
			}));
		}

		return prs
			.map((pr) => {
				const repo = repoMap.get(pr.repositoryId);
				const repoName = repo?.fullName ?? '';

				const titleScore = fuzzyScore(q, pr.title);
				const branchScore = fuzzyScore(q, pr.sourceBranch);
				const idScore = fuzzyScore(q, `#${pr.externalId}`);
				const authorScore = fuzzyScore(q, pr.authorLogin);
				const repoScore = fuzzyScore(q, repoName);
				const best = Math.max(titleScore, branchScore, idScore, authorScore, repoScore);

				return { pr, repoName, score: best };
			})
			.filter((r) => r.score >= 0)
			.sort((a, b) => b.score - a.score);
	});

	// ── Unified item list ────────────────────────────────

	const commands = $derived(mode === 'command' ? getFilteredCommands() : []);
	const itemCount = $derived(mode === 'search' ? prResults.length : commands.length);

	// ── Reset on open/mode change ────────────────────────

	$effect(() => {
		if (open) {
			selectedIndex = 0;

			if (mode === 'command') {
				inputValue = '>';
				setCommandQuery('');
			} else {
				inputValue = '';
				resetQuery();
			}

			// Focus input on next tick
			requestAnimationFrame(() => inputEl?.focus());
		}
	});

	// Clamp selectedIndex when item count changes
	$effect(() => {
		const count = itemCount;
		if (count > 0 && untrack(() => selectedIndex) >= count) {
			selectedIndex = count - 1;
		}
	});

	// ── Keyboard navigation ──────────────────────────────

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			onClose();
			return;
		}

		if (e.key === 'ArrowDown') {
			e.preventDefault();
			if (itemCount > 0) {
				selectedIndex = (selectedIndex + 1) % itemCount;
				scrollToSelected();
			}
			return;
		}

		if (e.key === 'ArrowUp') {
			e.preventDefault();
			if (itemCount > 0) {
				selectedIndex = (selectedIndex - 1 + itemCount) % itemCount;
				scrollToSelected();
			}
			return;
		}

		if (e.key === 'Enter') {
			e.preventDefault();
			executeSelected();
			return;
		}
	}

	function scrollToSelected() {
		requestAnimationFrame(() => {
			const item = listEl?.querySelector(`[data-index="${selectedIndex}"]`);
			item?.scrollIntoView({ block: 'nearest' });
		});
	}

	function executeSelected() {
		if (mode === 'search') {
			const result = prResults[selectedIndex];
			if (result) {
				onClose();
				selectPr(result.pr.id);
			}
		} else {
			const cmd = commands[selectedIndex];
			if (cmd) {
				onClose();
				cmd.action();
			}
		}
	}

	function handleItemClick(index: number) {
		selectedIndex = index;
		executeSelected();
	}
</script>

{#if open}
	<!-- Backdrop -->
	<div
		class="fixed inset-0 z-40 bg-black/60"
		role="presentation"
		onclick={onClose}
		transition:fade={{ duration: 150 }}
	></div>

	<!-- Palette -->
	<div
		class="palette"
		role="dialog"
		aria-modal="true"
		aria-label={mode === 'command' ? 'Command palette' : 'Search pull requests'}
		transition:scale={{ duration: 150, start: 0.96, easing: cubicOut }}
	>
		<!-- Search input -->
		<div class="palette-input-wrap">
			<Search size={14} class="palette-search-icon" />
			<input
				bind:this={inputEl}
				class="palette-input"
				type="text"
				placeholder={mode === 'command' ? 'Type a command...' : 'Search pull requests...'}
				value={inputValue}
				oninput={handleInput}
				onkeydown={handleKeydown}
				spellcheck={false}
				autocomplete="off"
			/>
		</div>

		<!-- Results list -->
		<div class="palette-list" role="listbox" bind:this={listEl}>
			{#if mode === 'search'}
				{#each prResults as result, i (result.pr.id)}
					<button
						class="palette-item palette-item--pr"
						class:palette-item--active={i === selectedIndex}
						role="option"
						aria-selected={i === selectedIndex}
						data-index={i}
						onclick={() => handleItemClick(i)}
						onmouseenter={() => (selectedIndex = i)}
					>
						<div class="pr-row-top">
							{#if result.pr.authorAvatarUrl}
								<img
									src={result.pr.authorAvatarUrl}
									alt=""
									class="pr-avatar"
								/>
							{/if}
							<span class="pr-title">{result.pr.title}</span>
							<span class="pr-meta">
								{result.repoName}
								<span class="pr-number">#{result.pr.externalId}</span>
							</span>
						</div>
						<div class="pr-row-bottom">
							<span class="pr-branch">{result.pr.sourceBranch}</span>
						</div>
					</button>
				{/each}

				{#if prResults.length === 0}
					<div class="palette-empty">No matching pull requests</div>
				{/if}
			{:else}
				{#each commands as cmd, i (cmd.id)}
					<button
						class="palette-item palette-item--cmd"
						class:palette-item--active={i === selectedIndex}
						role="option"
						aria-selected={i === selectedIndex}
						data-index={i}
						onclick={() => handleItemClick(i)}
						onmouseenter={() => (selectedIndex = i)}
					>
						<span class="cmd-label">{cmd.label}</span>
						{#if cmd.shortcut}
							<kbd class="cmd-shortcut">{cmd.shortcut}</kbd>
						{/if}
					</button>
				{/each}

				{#if commands.length === 0}
					<div class="palette-empty">No matching commands</div>
				{/if}
			{/if}
		</div>
	</div>
{/if}

<style>
	/* ── Palette container ─────────────────────────────── */
	.palette {
		position: fixed;
		z-index: 50;
		top: 20%;
		left: 0;
		right: 0;
		margin-inline: auto;
		width: 100%;
		max-width: 520px;
		border-radius: 12px;
		border: 1px solid var(--color-border);
		background: var(--color-bg-secondary);
		box-shadow:
			0 16px 48px rgba(0, 0, 0, 0.2),
			0 4px 12px rgba(0, 0, 0, 0.1);
		overflow: hidden;
	}

	/* ── Input ─────────────────────────────────────────── */
	.palette-input-wrap {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 12px 16px;
		border-bottom: 1px solid var(--color-border-subtle);
	}

	:global(.palette-search-icon) {
		color: var(--color-text-muted);
		flex-shrink: 0;
	}

	.palette-input {
		flex: 1;
		border: none;
		background: transparent;
		font-size: 14px;
		font-family: var(--font-sans);
		color: var(--color-text-primary);
		outline: none;
	}

	.palette-input::placeholder {
		color: var(--color-text-muted);
	}

	/* ── List ──────────────────────────────────────────── */
	.palette-list {
		max-height: 340px;
		overflow-y: auto;
		padding: 4px 0;
	}

	.palette-empty {
		padding: 24px 16px;
		text-align: center;
		font-size: 12px;
		color: var(--color-text-muted);
	}

	/* ── Item (shared) ─────────────────────────────────── */
	.palette-item {
		display: flex;
		width: 100%;
		border: none;
		background: transparent;
		cursor: pointer;
		text-align: left;
		padding: 8px 16px;
		transition: background-color var(--duration-snap);
	}

	.palette-item--active {
		background: var(--color-tree-active-bg);
	}

	/* ── Command item ──────────────────────────────────── */
	.palette-item--cmd {
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}

	.cmd-label {
		font-size: 13px;
		color: var(--color-text-secondary);
	}

	.palette-item--active .cmd-label {
		color: var(--color-tree-active-text);
	}

	.cmd-shortcut {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--color-text-muted);
		background: var(--color-bg-tertiary);
		padding: 2px 6px;
		border-radius: 4px;
		border: 1px solid var(--color-border-subtle);
		flex-shrink: 0;
	}

	/* ── PR item ───────────────────────────────────────── */
	.palette-item--pr {
		flex-direction: column;
		gap: 2px;
	}

	.pr-row-top {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		min-width: 0;
	}

	.pr-avatar {
		width: 16px;
		height: 16px;
		border-radius: 4px;
		flex-shrink: 0;
	}

	.pr-title {
		font-size: 13px;
		font-weight: 500;
		color: var(--color-text-primary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		flex: 1;
		min-width: 0;
	}

	.palette-item--active .pr-title {
		color: var(--color-tree-active-text);
	}

	.pr-meta {
		font-size: 11px;
		color: var(--color-text-muted);
		white-space: nowrap;
		flex-shrink: 0;
	}

	.pr-number {
		font-family: var(--font-mono);
		margin-left: 4px;
	}

	.pr-row-bottom {
		padding-left: 24px;
	}

	.pr-branch {
		font-size: 11px;
		font-family: var(--font-mono);
		color: var(--color-text-muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
</style>
