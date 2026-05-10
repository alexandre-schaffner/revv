<script lang="ts">
	import { onDestroy, onMount, tick, untrack } from 'svelte';
	import { X } from '@lucide/svelte';
	import {
		FileDiff as PierreFileDiff,
		parsePatchFiles,
		type FileDiffMetadata,
		type FileDiffOptions,
	} from '@pierre/diffs';
	import { FileTree, type GitStatusEntry } from '@pierre/trees';
	import { workerManager } from '$lib/utils/worker-pool';

	interface Props {
		sha: string;
		subject: string;
		body: string;
		onClose: () => void;
	}

	let { sha, subject, body, onClose }: Props = $props();

	// Parsed once on mount. The modal is short-lived (a fresh instance per
	// commit click), so a snapshot read is exactly what we want — `untrack`
	// tells Svelte the snapshot is intentional rather than a missed
	// dependency.
	const files: FileDiffMetadata[] = untrack(() =>
		parsePatchFiles(body, `chat-diff-${sha}`).flatMap((p) => p.files),
	);

	const paths = files.map((f) => f.name);

	function statusFromType(type: FileDiffMetadata['type']): GitStatusEntry['status'] {
		if (type === 'new') return 'added';
		if (type === 'deleted') return 'deleted';
		if (type === 'rename-pure' || type === 'rename-changed') return 'renamed';
		return 'modified';
	}

	const gitStatus: GitStatusEntry[] = files.map((f) => ({
		path: f.name,
		status: statusFromType(f.type),
	}));

	let treeHostEl: HTMLElement | undefined = $state();
	let scrollEl: HTMLDivElement | undefined = $state();
	const diffWrapperEls: (HTMLDivElement | null)[] = files.map(() => null);
	const diffInstances: (PierreFileDiff | null)[] = files.map(() => null);
	let tree: FileTree | null = null;

	// Mount FileDiff lazily as each per-file wrapper element is captured.
	// Using an action (rather than `bind:this` into an array) sidesteps Svelte
	// 5's strict typing on indexed array binds and gives us a deterministic
	// `destroy` hook for cleanup if the modal closes mid-mount.
	function captureDiffEl(el: HTMLDivElement, index: number) {
		diffWrapperEls[index] = el;

		const file = files[index];
		if (file && !diffInstances[index]) {
			const options: FileDiffOptions<undefined> = {
				diffStyle: 'unified',
				theme: { dark: 'pierre-dark', light: 'pierre-light' },
				themeType: 'dark',
				hunkSeparators: 'metadata',
			};
			const instance = new PierreFileDiff<undefined>(options, workerManager);
			instance.render({
				containerWrapper: el,
				fileDiff: file,
				forceRender: true,
			});
			diffInstances[index] = instance;
		}

		return {
			destroy() {
				diffWrapperEls[index] = null;
				const instance = diffInstances[index];
				if (instance) {
					try {
						instance.cleanUp();
					} catch {
						// best-effort
					}
					diffInstances[index] = null;
				}
			},
		};
	}

	onMount(() => {
		if (!treeHostEl || files.length === 0) return;

		const initialSelection = paths.length > 0 && paths[0] != null ? [paths[0]] : [];

		tree = new FileTree({
			paths,
			gitStatus,
			initialExpansion: 'open',
			initialSelectedPaths: initialSelection,
			onSelectionChange: (selected) => {
				const path = selected[0];
				if (typeof path !== 'string') return;
				const idx = paths.indexOf(path);
				if (idx < 0) return;
				const target = diffWrapperEls[idx];
				if (!target || !scrollEl) return;
				const top = target.offsetTop - scrollEl.offsetTop;
				scrollEl.scrollTo({ top, behavior: 'smooth' });
			},
			unsafeCSS: `
				button[data-type='item'][data-item-contains-git-change='true'] > [data-item-section='content'] {
					color: var(--trees-git-modified-color);
				}
				[data-file-tree-virtualized-scroll='true'] {
					scrollbar-gutter: auto;
					padding-inline: 2px;
				}
			`,
		});
		tree.render({ containerWrapper: treeHostEl });

		void tick().then(() => {
			scrollEl?.scrollTo({ top: 0 });
		});
	});

	onDestroy(() => {
		// Per-file instances are torn down by their action's `destroy` hooks,
		// so we only need to clean up the file tree here.
		tree?.cleanUp();
		tree = null;
	});

	// Reparent to document.body so `position: fixed` is anchored to the
	// viewport. The right panel's parent element has a `transform`, which
	// would otherwise scope `position: fixed` to the panel rather than the
	// screen.
	function portal(node: HTMLElement) {
		document.body.appendChild(node);
		return {
			destroy() {
				if (node.parentNode === document.body) {
					document.body.removeChild(node);
				}
			},
		};
	}
</script>

<div
	class="overlay"
	use:portal
	role="dialog"
	aria-modal="true"
	aria-label="Proposed commit diff"
>
	<button
		type="button"
		class="backdrop"
		aria-label="Close diff"
		onclick={onClose}
	></button>
	<div class="card" role="document">
		<header class="card-header">
			<code class="card-sha">{sha.slice(0, 12)}</code>
			<span class="card-subject" title={subject}>{subject}</span>
			<span class="card-files">{files.length} file{files.length === 1 ? '' : 's'}</span>
			<button class="icon-btn" onclick={onClose} aria-label="Close diff">
				<X size={14} />
			</button>
		</header>
		<div class="card-body">
			<aside class="card-tree" bind:this={treeHostEl}></aside>
			<div class="card-diffs" bind:this={scrollEl}>
				{#if files.length === 0}
					<div class="empty">No file changes in this commit.</div>
				{:else}
					{#each files as file, i (file.name)}
						<div class="diff-block" use:captureDiffEl={i}></div>
					{/each}
				{/if}
			</div>
		</div>
	</div>
</div>

<style>
	.overlay {
		position: fixed;
		inset: 0;
		z-index: 1000;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 32px;
	}

	.backdrop {
		position: absolute;
		inset: 0;
		border: none;
		background: rgba(0, 0, 0, 0.55);
		cursor: default;
		padding: 0;
		margin: 0;
	}

	.card {
		position: relative;
		width: min(1100px, 92vw);
		height: min(80vh, 800px);
		background: var(--color-panel-bg);
		border: 1px solid var(--color-border);
		border-radius: 8px;
		display: flex;
		flex-direction: column;
		overflow: hidden;
		box-shadow: 0 24px 60px rgba(0, 0, 0, 0.45);
	}

	.card-header {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 10px 12px;
		border-bottom: 1px solid var(--color-border-subtle);
		background: var(--color-bg-secondary);
		flex-shrink: 0;
	}

	.card-sha {
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--color-accent);
		flex-shrink: 0;
	}

	.card-subject {
		font-size: 13px;
		color: var(--color-text-primary);
		flex: 1;
		min-width: 0;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.card-files {
		font-size: 11px;
		color: var(--color-text-muted);
		flex-shrink: 0;
	}

	.icon-btn {
		width: 24px;
		height: 24px;
		border-radius: 4px;
		border: none;
		background: transparent;
		color: var(--color-text-muted);
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		transition: background-color var(--duration-snap), color var(--duration-snap);
	}

	.icon-btn:hover {
		background: var(--color-bg-tertiary);
		color: var(--color-text-secondary);
	}

	.card-body {
		flex: 1;
		display: grid;
		grid-template-columns: 240px 1fr;
		min-height: 0;
		overflow: hidden;
	}

	.card-tree {
		min-height: 0;
		border-right: 1px solid var(--color-border-subtle);
		background: var(--color-bg-secondary);
		display: flex;
		flex-direction: column;
		color-scheme: dark;
		overflow: hidden;
		--trees-bg-override: var(--color-bg-secondary);
		--trees-fg-override: var(--color-text-secondary);
		--trees-fg-muted-override: var(--color-text-muted);
		--trees-border-color-override: var(--color-border);
		--trees-selected-bg-override: var(--color-tree-active-bg);
		--trees-selected-fg-override: var(--color-tree-active-text);
		--trees-accent-override: var(--color-accent);
		--trees-bg-muted-override: var(--color-bg-tertiary);
		--trees-padding-inline-override: 4px;
	}

	.card-diffs {
		min-height: 0;
		overflow-y: auto;
		background: var(--color-panel-bg);
	}

	.diff-block {
		--diffs-gap-inline: 8px;
		--diffs-tab-size: 2;
		--diffs-min-number-column-width: 2ch;
		border-bottom: 1px solid var(--color-border-subtle);
	}

	.diff-block:last-child {
		border-bottom: none;
	}

	.empty {
		padding: 32px;
		text-align: center;
		font-size: 12px;
		color: var(--color-text-muted);
	}
</style>
