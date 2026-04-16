<script lang="ts">
	import { untrack } from 'svelte';
	import { ChevronRight, FileCode2, FilePlus2, FileMinus2, FolderOpen, Folder } from '@lucide/svelte';
	import type { FileTreeEntry } from '$lib/types/review';
	import { getFocusedId } from '$lib/stores/sidebar-nav.svelte';

	interface Props {
		files: FileTreeEntry[];
		activeFilePath?: string | null;
		onFileSelect: (path: string) => void;
		showHeader?: boolean;
		/** When set, file/dir rows get data-sidebar-nav attributes for vim navigation. */
		navParentId?: string | undefined;
	}

	let { files, activeFilePath, onFileSelect, showHeader = true, navParentId }: Props = $props();

	const focusedNavId = $derived(getFocusedId());

	// Build a tree structure from flat file paths
	interface TreeNode {
		name: string;
		path: string;
		isDir: boolean;
		children: TreeNode[];
		file: FileTreeEntry | undefined;
	}

	function buildTree(files: FileTreeEntry[]): TreeNode[] {
		const root: TreeNode = { name: '', path: '', isDir: true, children: [], file: undefined };

		for (const file of files) {
			const parts = file.path.split('/');
			let current = root;

			for (let i = 0; i < parts.length; i++) {
				const part = parts[i]!;
				const isLast = i === parts.length - 1;
				const pathSoFar = parts.slice(0, i + 1).join('/');

				let child = current.children.find((c) => c.name === part);
				if (!child) {
					child = {
						name: part,
						path: pathSoFar,
						isDir: !isLast,
						children: [],
						file: isLast ? file : undefined
					} satisfies TreeNode;
					current.children.push(child);
				}
				current = child;
			}
		}

		return root.children;
	}

	let expandedDirs = $state<Set<string>>(new Set());

	const tree = $derived(buildTree(files));

	// Auto-expand all dirs that contain the active file
	$effect(() => {
		if (!activeFilePath) return;
		const parts = activeFilePath.split('/');
		const next = new Set(untrack(() => expandedDirs));
		for (let i = 1; i < parts.length; i++) {
			next.add(parts.slice(0, i).join('/'));
		}
		expandedDirs = next;
	});

	function toggleDir(path: string) {
		const next = new Set(expandedDirs);
		if (next.has(path)) next.delete(path);
		else next.add(path);
		expandedDirs = next;
	}
</script>

<div class="file-tree">
	<!-- Header (suppressed when parent owns it) -->
	{#if showHeader}
		<div class="tree-header">
			<span class="tree-label">Files</span>
			<span class="file-count">{files.length}</span>
		</div>
	{/if}

	<!-- Tree -->
	<div class="tree-body">
		{#snippet renderNodes(nodes: ReturnType<typeof buildTree>, depth: number, parentNav: string | undefined)}
			{#each nodes as node}
				{#if node.isDir}
					<!-- Directory row -->
					{@const dirNavId = navParentId ? `dir:${node.path}` : undefined}
					<button
						class="tree-row tree-row--dir {dirNavId && focusedNavId === dirNavId ? 'sidebar-nav-focused' : ''}"
						style="padding-left: {12 + depth * 12}px"
						onclick={() => toggleDir(node.path)}
						data-sidebar-nav={dirNavId}
						data-nav-type={dirNavId ? 'dir' : undefined}
						data-nav-expanded={dirNavId ? expandedDirs.has(node.path) : undefined}
						data-nav-parent={parentNav}
					>
						<span
							class="dir-chevron"
							class:dir-chevron--open={expandedDirs.has(node.path)}
						>
							<ChevronRight size={10} />
						</span>
						{#if expandedDirs.has(node.path)}
							<FolderOpen size={13} class="dir-icon dir-icon--open" />
						{:else}
							<Folder size={13} class="dir-icon" />
						{/if}
						<span class="dir-name">{node.name}</span>
					</button>
					{#if expandedDirs.has(node.path)}
						{@render renderNodes(node.children, depth + 1, dirNavId)}
					{/if}
				{:else}
					<!-- File row -->
					{@const isActive = activeFilePath === node.path}
					{@const fileNavId = navParentId ? `file:${node.path}` : undefined}
					<button
						class="tree-row tree-row--file {fileNavId && focusedNavId === fileNavId ? 'sidebar-nav-focused' : ''}"
						class:tree-row--active={isActive}
						style="padding-left: {12 + depth * 12}px"
						onclick={() => onFileSelect(node.path)}
						data-sidebar-nav={fileNavId}
						data-nav-type={fileNavId ? 'file' : undefined}
						data-nav-parent={parentNav}
					>
						{#if node.file?.isNew}
						<FilePlus2 size={13} class="file-icon file-icon--added" />
					{:else if node.file?.isDeleted}
						<FileMinus2 size={13} class="file-icon file-icon--deleted" />
					{:else}
						<FileCode2 size={13} class="file-icon file-icon--modified" />
					{/if}
						<span class="file-name">{node.name}</span>
						{#if node.file}
							<span class="file-stats">
								{#if node.file.deletions > 0}
									<span class="stat-del">-{node.file.deletions}</span>
								{/if}
								{#if node.file.additions > 0}
									<span class="stat-add">+{node.file.additions}</span>
								{/if}
							</span>
						{/if}
					</button>
				{/if}
			{/each}
		{/snippet}
		{@render renderNodes(tree, 0, navParentId)}
	</div>
</div>

<style>
	.file-tree {
		display: flex;
		flex-direction: column;
		height: 100%;
		user-select: none;
	}

	.tree-header {
		height: 36px;
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0 12px;
		border-bottom: 1px solid var(--color-border-subtle);
		flex-shrink: 0;
	}

	.tree-label {
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--color-text-muted);
	}

	.file-count {
		font-size: 10px;
		color: var(--color-tab-inactive-text);
		background: var(--color-bg-tertiary);
		border-radius: 4px;
		padding: 1px 5px;
	}

	.tree-body {
		flex: 1;
		overflow-y: auto;
		padding: 4px 0;
	}

	/* Rows */
	.tree-row {
		display: flex;
		align-items: center;
		gap: 6px;
		height: 28px;
		width: 100%;
		padding-right: 8px;
		border: none;
		background: transparent;
		cursor: pointer;
		text-align: left;
		transition: background-color var(--duration-snap);
	}

	.tree-row:hover {
		background: var(--color-tree-hover-bg);
	}

	/* Active file */
	.tree-row--active {
		background: var(--color-tree-active-bg) !important;
		box-shadow: inset 2px 0 0 var(--color-accent);
	}

	.tree-row--active .file-name {
		color: var(--color-tree-active-text) !important;
	}

	/* Directory */
	.tree-row--dir {
		gap: 4px;
	}

	.dir-chevron {
		color: var(--color-text-muted);
		display: flex;
		align-items: center;
		transition: transform var(--duration-snap) var(--ease-out-expo);
		flex-shrink: 0;
	}

	.dir-chevron--open {
		transform: rotate(90deg);
	}

	:global(.dir-icon) {
		color: rgba(59, 130, 246, 0.5);
		flex-shrink: 0;
	}

	:global(.dir-icon--open) {
		color: var(--color-accent);
	}

	.dir-name {
		font-size: 11px;
		font-weight: 500;
		color: var(--color-tab-inactive-text);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	/* File */
	:global(.file-icon) {
		color: var(--color-text-muted);
		flex-shrink: 0;
		transition: color var(--duration-snap);
	}

	:global(.file-icon--added) {
		color: var(--color-success);
	}

	:global(.file-icon--deleted) {
		color: var(--color-danger);
	}

	.tree-row:hover :global(.file-icon) {
		color: var(--color-tab-inactive-text);
	}

	.file-name {
		font-family: var(--font-mono);
		font-size: 12px;
		color: var(--color-text-secondary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		flex: 1;
		min-width: 0;
	}

	/* Stats */
	.file-stats {
		display: flex;
		align-items: center;
		gap: 4px;
		flex-shrink: 0;
	}

	.stat-add {
		font-size: 10px;
		font-family: var(--font-mono);
		color: var(--color-success);
	}

	.stat-del {
		font-size: 10px;
		font-family: var(--font-mono);
		color: var(--color-danger);
	}
</style>
