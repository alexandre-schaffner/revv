<script lang="ts">
	import { mount, onDestroy, onMount, tick, unmount, untrack, type Component } from 'svelte';
	import { X, PanelLeftClose, PanelLeftOpen, MessageSquare, Send } from '@lucide/svelte';
	import {
		FileDiff as PierreFileDiff,
		parsePatchFiles,
		type DiffLineAnnotation,
		type FileDiffMetadata,
		type FileDiffOptions,
	} from '@pierre/diffs';
	import { FileTree, type GitStatusEntry } from '@pierre/trees';
	import { SvelteMap } from 'svelte/reactivity';
	import { workerManager } from '$lib/utils/worker-pool';
	import AnnotationCommentInput from './AnnotationCommentInput.svelte';
	import ProposedCommentChip from './ProposedCommentChip.svelte';
	import { getDiffMode, setDiffMode } from '$lib/stores/review.svelte';
	import {
		addProposedComment,
		getProposedComments,
		isChatStreaming,
		removeProposedComment,
		sendProposedFeedback,
		updateProposedComment,
		type ProposedComment,
	} from '$lib/stores/chat.svelte';

	interface Props {
		prId: string;
		sha: string;
		subject: string;
		body: string;
		onClose: () => void;
	}

	let { prId, sha, subject, body, onClose }: Props = $props();

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

	// ── DOM refs ──────────────────────────────────────────────────────────────
	let treeHostEl: HTMLElement | undefined = $state();
	let scrollEl: HTMLDivElement | undefined = $state();
	const diffWrapperEls: (HTMLDivElement | null)[] = files.map(() => null);
	const diffInstances: (PierreFileDiff<CommentMeta> | null)[] = files.map(() => null);
	let tree: FileTree | null = null;

	// Scoped Svelte mount tracker for annotation hosts. Kept local so the
	// modal can clean up its own mounts on destroy without disturbing any
	// concurrently-rendered DiffViewer (which uses the global registry in
	// `$lib/utils/annotation-mount`).
	type MountedInstance = ReturnType<typeof mount>;
	const annotationMounts = new Map<HTMLElement, MountedInstance>();

	function scopedMount<Props extends Record<string, unknown>>(
		host: HTMLElement,
		Component: Component<Props>,
		props: Props,
	): void {
		const existing = annotationMounts.get(host);
		if (existing) {
			try {
				unmount(existing);
			} catch {
				// best-effort
			}
			annotationMounts.delete(host);
		}
		const instance = mount(Component, { target: host, props });
		annotationMounts.set(host, instance);
	}

	function cleanupScopedMounts(): void {
		for (const [host, instance] of annotationMounts) {
			try {
				unmount(instance);
			} catch {
				// best-effort
			}
			annotationMounts.delete(host);
		}
	}

	// ── Reactive UI state ─────────────────────────────────────────────────────
	const mode = $derived(getDiffMode());
	let isTreeCollapsed = $state(false);

	// Pending input slots — keyed `${filePath}::${lineNumber}::${side}`. Stores
	// the comment id when editing an existing chip, undefined when creating a
	// new one.
	const pendingInputs = new SvelteMap<string, { editingId: string | undefined }>();

	const comments = $derived(getProposedComments(prId, sha));
	const commentCount = $derived(comments.length);
	const isStreaming = $derived(isChatStreaming(prId));
	const canSend = $derived(commentCount > 0 && !isStreaming);

	// ── Annotation metadata ───────────────────────────────────────────────────
	interface CommentMeta {
		kind: 'input' | 'chip';
		commentId?: string;
	}

	function pendingKey(filePath: string, lineNumber: number, side: string): string {
		return `${filePath}::${lineNumber}::${side}`;
	}

	function annotationsFor(file: FileDiffMetadata): DiffLineAnnotation<CommentMeta>[] {
		const out: DiffLineAnnotation<CommentMeta>[] = [];
		// Pre-compute the pending-input slots for this file. When an input is
		// open on a line, the matching chip is suppressed — the input replaces
		// it visually (and submit either updates or creates the comment).
		const pendingSlots = new Set<string>();
		for (const [key] of pendingInputs) {
			const [filePath, lineStr, side] = key.split('::');
			if (filePath !== file.name) continue;
			pendingSlots.add(`${lineStr}::${side}`);
		}
		for (const c of comments) {
			if (c.filePath !== file.name) continue;
			if (pendingSlots.has(`${c.lineNumber}::${c.side}`)) continue;
			out.push({
				side: c.side,
				lineNumber: c.lineNumber,
				metadata: { kind: 'chip', commentId: c.id },
			});
		}
		for (const [key] of pendingInputs) {
			const [filePath, lineStr, side] = key.split('::');
			if (filePath !== file.name) continue;
			const lineNumber = Number(lineStr);
			if (!Number.isFinite(lineNumber)) continue;
			if (side !== 'deletions' && side !== 'additions') continue;
			out.push({
				side,
				lineNumber,
				metadata: { kind: 'input' },
			});
		}
		return out;
	}

	// ── FileDiff lifecycle ────────────────────────────────────────────────────
	function buildOptions(
		file: FileDiffMetadata,
		diffStyle: 'unified' | 'split',
	): FileDiffOptions<CommentMeta> {
		return {
			diffStyle,
			theme: { dark: 'pierre-dark', light: 'pierre-light' },
			themeType: 'dark',
			hunkSeparators: 'metadata',
			lineHoverHighlight: 'both',
			onLineClick(props) {
				// Pierre treats context-line clicks as `lineType: 'context'` —
				// allow comments on any line of the diff.
				const side = props.annotationSide;
				if (side !== 'deletions' && side !== 'additions') return;
				handleLineClick(file.name, props.lineNumber, side);
			},
			renderAnnotation(annotation) {
				const meta = annotation.metadata;
				if (!meta) return undefined;
				const host = document.createElement('div');
				host.style.cssText = 'display:block;width:100%;';

				if (meta.kind === 'input') {
					const existing = comments.find(
						(c) =>
							c.filePath === file.name &&
							c.lineNumber === annotation.lineNumber &&
							c.side === annotation.side,
					);
					scopedMount(host, AnnotationCommentInput, {
						filePath: file.name,
						lineNo: annotation.lineNumber,
						initialBody: existing?.body ?? '',
						onSubmit: (next: string) => {
							handleCommentSubmit(
								file.name,
								annotation.lineNumber,
								annotation.side,
								next,
								existing?.id,
							);
						},
						onDismiss: () => {
							dismissPendingInput(file.name, annotation.lineNumber, annotation.side);
						},
					});
				} else if (meta.kind === 'chip' && meta.commentId) {
					const c = comments.find((x) => x.id === meta.commentId);
					if (!c) return host;
					scopedMount(host, ProposedCommentChip, {
						body: c.body,
						onEdit: () => {
							openInput(c.filePath, c.lineNumber, c.side, c.id);
						},
						onDelete: () => {
							removeProposedComment(prId, sha, c.id);
						},
					});
				}
				return host;
			},
		};
	}

	function mountFileDiff(idx: number, el: HTMLDivElement, diffStyle: 'unified' | 'split') {
		const file = files[idx];
		if (!file) return;
		const options = buildOptions(file, diffStyle);
		const instance = new PierreFileDiff<CommentMeta>(options, workerManager);
		instance.render({
			containerWrapper: el,
			fileDiff: file,
			lineAnnotations: annotationsFor(file),
			forceRender: true,
		});
		diffInstances[idx] = instance;
	}

	// Mount FileDiff lazily as each per-file wrapper element is captured.
	// Using an action (rather than `bind:this` into an array) sidesteps Svelte
	// 5's strict typing on indexed array binds and gives us a deterministic
	// `destroy` hook for cleanup if the modal closes mid-mount.
	function captureDiffEl(el: HTMLDivElement, index: number) {
		diffWrapperEls[index] = el;
		if (!diffInstances[index]) {
			mountFileDiff(index, el, untrack(() => mode));
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

	// ── Reactive: re-render annotations when comments / pendingInputs change ──
	let didFirstAnnotationRender = false;
	$effect(() => {
		// Subscribe to both signals.
		void comments;
		void pendingInputs.size;
		// Skip the very first run — instances are still being constructed via
		// the action and render() was already called with annotations there.
		if (!didFirstAnnotationRender) {
			didFirstAnnotationRender = true;
			return;
		}
		for (let i = 0; i < files.length; i++) {
			const inst = diffInstances[i];
			const file = files[i];
			if (!inst || !file) continue;
			try {
				inst.render({
					lineAnnotations: annotationsFor(file),
					forceRender: true,
				});
			} catch {
				// best-effort
			}
		}
	});

	// ── Reactive: mode changes — destroy + recreate every FileDiff ────────────
	let lastMode = $state(untrack(() => mode));
	$effect(() => {
		const next = mode;
		if (next === lastMode) return;
		lastMode = next;
		// All annotation hosts live inside the FileDiff DOM that's about to be
		// destroyed — unmount them first to avoid stranded Svelte instances
		// pointing at detached nodes.
		cleanupScopedMounts();
		for (let i = 0; i < files.length; i++) {
			const el = diffWrapperEls[i];
			const old = diffInstances[i];
			if (old) {
				try {
					old.cleanUp();
				} catch {
					// best-effort
				}
				diffInstances[i] = null;
			}
			if (el) mountFileDiff(i, el, next);
		}
	});

	// ── Comment handlers ──────────────────────────────────────────────────────
	function openInput(
		filePath: string,
		lineNumber: number,
		side: 'deletions' | 'additions',
		editingId?: string,
	) {
		// Only one input open at a time keeps the UX focused.
		pendingInputs.clear();
		pendingInputs.set(pendingKey(filePath, lineNumber, side), { editingId });
	}

	function dismissPendingInput(
		filePath: string,
		lineNumber: number,
		side: 'deletions' | 'additions',
	) {
		pendingInputs.delete(pendingKey(filePath, lineNumber, side));
	}

	function handleLineClick(
		filePath: string,
		lineNumber: number,
		side: 'deletions' | 'additions',
	) {
		const key = pendingKey(filePath, lineNumber, side);
		// Toggle: clicking the same line again dismisses
		if (pendingInputs.has(key)) {
			pendingInputs.delete(key);
			return;
		}
		// If a chip already exists, open it for edit; otherwise start fresh.
		const existing = comments.find(
			(c) => c.filePath === filePath && c.lineNumber === lineNumber && c.side === side,
		);
		openInput(filePath, lineNumber, side, existing?.id);
	}

	function handleCommentSubmit(
		filePath: string,
		lineNumber: number,
		side: 'deletions' | 'additions',
		commentBody: string,
		editingId: string | undefined,
	) {
		const key = pendingKey(filePath, lineNumber, side);
		pendingInputs.delete(key);
		if (editingId) {
			updateProposedComment(prId, sha, editingId, commentBody);
		} else {
			const comment: ProposedComment = {
				id: crypto.randomUUID(),
				filePath,
				lineNumber,
				side,
				body: commentBody,
			};
			addProposedComment(prId, sha, comment);
		}
	}

	function handleSendFeedback() {
		if (!canSend) return;
		const ok = sendProposedFeedback({ prId, sha, subject });
		if (ok) onClose();
	}

	function toggleTree() {
		isTreeCollapsed = !isTreeCollapsed;
	}

	// ── File tree ─────────────────────────────────────────────────────────────
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
		// so we only need to clean up the file tree + the Svelte mounts this
		// modal owns.
		cleanupScopedMounts();
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
			<button
				class="icon-btn"
				onclick={toggleTree}
				aria-label={isTreeCollapsed ? 'Show file tree' : 'Hide file tree'}
				title={isTreeCollapsed ? 'Show file tree' : 'Hide file tree'}
			>
				{#if isTreeCollapsed}
					<PanelLeftOpen size={14} />
				{:else}
					<PanelLeftClose size={14} />
				{/if}
			</button>
			<code class="card-sha">{sha.slice(0, 12)}</code>
			<span class="card-subject" title={subject}>{subject}</span>
			<span class="card-files">{files.length} file{files.length === 1 ? '' : 's'}</span>
			<div class="view-pill" role="group" aria-label="Diff view mode">
				<button
					type="button"
					class="view-btn"
					class:view-btn--active={mode === 'unified'}
					onclick={() => setDiffMode('unified')}
					aria-pressed={mode === 'unified'}
					title="Unified view"
					aria-label="Unified view"
				>
					<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
						<line x1="3.5" y1="4.5" x2="12.5" y2="4.5" />
						<line x1="3.5" y1="8" x2="12.5" y2="8" />
						<line x1="3.5" y1="11.5" x2="12.5" y2="11.5" />
					</svg>
				</button>
				<div class="view-sep"></div>
				<button
					type="button"
					class="view-btn"
					class:view-btn--active={mode === 'split'}
					onclick={() => setDiffMode('split')}
					aria-pressed={mode === 'split'}
					title="Split view"
					aria-label="Split view"
				>
					<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
						<rect x="2" y="2.5" width="12" height="11" rx="1.5" />
						<line x1="8" y1="2.5" x2="8" y2="13.5" />
					</svg>
				</button>
			</div>
			<button class="icon-btn" onclick={onClose} aria-label="Close diff">
				<X size={14} />
			</button>
		</header>
		<div class="card-body" class:card-body--tree-collapsed={isTreeCollapsed}>
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
		<footer class="card-footer">
			<div class="footer-summary">
				<MessageSquare size={12} />
				{#if commentCount === 0}
					<span class="footer-hint">Click a line to leave feedback for the agent.</span>
				{:else}
					<span>
						{commentCount} comment{commentCount === 1 ? '' : 's'}
					</span>
					{#if isStreaming}
						<span class="footer-hint">Agent is responding…</span>
					{/if}
				{/if}
			</div>
			<button
				type="button"
				class="send-btn"
				class:send-btn--active={canSend}
				disabled={!canSend}
				onclick={handleSendFeedback}
				title={isStreaming
					? 'Wait for the current turn to finish'
					: 'Send all comments to the agent'}
			>
				<Send size={12} />
				<span>Send to agent</span>
			</button>
		</footer>
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

	/* ── View-mode pill ──────────────────────────────────────────────────── */
	.view-pill {
		display: inline-flex;
		align-items: stretch;
		border-radius: 6px;
		overflow: hidden;
		border: 1px solid var(--color-border-subtle);
		background: var(--color-bg-tertiary);
		flex-shrink: 0;
	}

	.view-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 26px;
		padding: 4px 0;
		cursor: pointer;
		color: var(--color-text-muted);
		background: transparent;
		border: none;
		transition: background-color var(--duration-snap), color var(--duration-snap);
	}

	.view-btn:hover {
		color: var(--color-text-secondary);
		background: var(--color-bg-secondary);
	}

	.view-btn--active {
		color: var(--color-text-primary);
		background: var(--color-panel-bg);
	}

	.view-btn--active:hover {
		background: var(--color-panel-bg);
	}

	.view-sep {
		width: 1px;
		flex-shrink: 0;
		background: var(--color-border-subtle);
	}

	/* ── Body grid ───────────────────────────────────────────────────────── */
	.card-body {
		flex: 1;
		display: grid;
		grid-template-columns: 240px 1fr;
		min-height: 0;
		overflow: hidden;
		transition: grid-template-columns var(--duration-quick) var(--ease-out-expo);
	}

	.card-body--tree-collapsed {
		grid-template-columns: 0px 1fr;
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

	.card-body--tree-collapsed .card-tree {
		visibility: hidden;
		border-right-color: transparent;
	}

	.card-diffs {
		min-height: 0;
		overflow-y: auto;
		background: var(--color-panel-bg);
		display: flex;
		flex-direction: column;
		gap: 16px;
		padding: 12px 12px 24px;
	}

	.diff-block {
		--diffs-gap-inline: 8px;
		--diffs-tab-size: 2;
		--diffs-min-number-column-width: 2ch;
		border: 1px solid var(--color-border-subtle);
		border-radius: 6px;
		overflow: hidden;
		background: var(--color-bg-secondary);
	}

	.empty {
		padding: 32px;
		text-align: center;
		font-size: 12px;
		color: var(--color-text-muted);
	}

	/* ── Footer ──────────────────────────────────────────────────────────── */
	.card-footer {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 10px 12px;
		border-top: 1px solid var(--color-border-subtle);
		background: var(--color-bg-secondary);
		flex-shrink: 0;
	}

	.footer-summary {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 12px;
		color: var(--color-text-secondary);
		min-width: 0;
	}

	.footer-hint {
		color: var(--color-text-muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.send-btn {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 6px 12px;
		border-radius: 6px;
		border: 1px solid var(--color-border);
		background: var(--color-bg-tertiary);
		color: var(--color-text-muted);
		font-size: 12px;
		font-weight: 500;
		cursor: not-allowed;
		flex-shrink: 0;
		transition:
			background-color var(--duration-snap),
			color var(--duration-snap),
			border-color var(--duration-snap);
	}

	.send-btn--active {
		background: var(--color-accent);
		border-color: var(--color-accent);
		color: var(--color-primary-foreground);
		cursor: pointer;
	}

	.send-btn--active:hover {
		background: var(--color-accent-hover);
		border-color: var(--color-accent-hover);
	}
</style>
