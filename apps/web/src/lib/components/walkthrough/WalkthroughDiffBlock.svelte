<script lang="ts">
	import type { DiffBlock } from '@rev/shared';
	import type { CommentThread, ThreadMessage } from '$lib/types/review';
	import {
		FileDiff,
		parsePatchFiles,
		type DiffLineAnnotation,
		type FileDiffOptions,
	} from '@pierre/diffs';
	import { workerManager } from '$lib/utils/worker-pool';
	import { renderMarkdown } from '$lib/utils/markdown';
	import { onDestroy } from 'svelte';
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import { createAnnotationScope } from '$lib/utils/annotation-mount';
	import AnnotationCommentInput from '../review/AnnotationCommentInput.svelte';
	import AnnotationThread from '../review/AnnotationThread.svelte';
	import {
		getThreadsForFile,
		getThreadMessages,
		addThread,
		addThreadMessage,
		resolveThread,
		reopenThread,
	} from '$lib/stores/review.svelte';

	// ── ThreadMeta (mirrors DiffViewerInner) ────────────────────────────────────

	interface ThreadMeta {
		threadId: string;
		status: string;
		messageCount: number;
		isExpanded: boolean;
		isInputActive: boolean;
		isReplying: boolean;
	}

	// ── Props ────────────────────────────────────────────────────────────────────

	interface Props {
		block: DiffBlock;
		themeType: 'light' | 'dark' | 'system';
		animateEntrance?: boolean;
	}

	let { block, themeType, animateEntrance = false }: Props = $props();

	const renderedAnnotation = $derived(
		block.annotation ? renderMarkdown(block.annotation) : null
	);

	// ── Scoped annotation mounting ──────────────────────────────────────────────

	const annotationScope = createAnnotationScope();

	// ── Comment interaction state ────────────────────────────────────────────────

	const expandedThreadIds = new SvelteSet<string>();
	let replyingThreadId = $state<string | null>(null);

	/** Pending new-comment inputs keyed by `${lineNumber}::${side}` */
	const pendingInputs = new SvelteMap<
		string,
		{ side: 'deletions' | 'additions'; lineNo: number }
	>();

	// ── Derived annotation data ─────────────────────────────────────────────────

	const fileThreads = $derived(getThreadsForFile(block.filePath));

	const annotations = $derived.by((): DiffLineAnnotation<ThreadMeta>[] => {
		const threadAnnotations: DiffLineAnnotation<ThreadMeta>[] = fileThreads.map((thread) => ({
			side: (thread.diffSide === 'old' ? 'deletions' : 'additions') as
				| 'deletions'
				| 'additions',
			lineNumber: thread.startLine,
			metadata: {
				threadId: thread.id,
				status: thread.status,
				messageCount: getThreadMessages(thread.id).length,
				isExpanded: expandedThreadIds.has(thread.id),
				isInputActive: false,
				isReplying: replyingThreadId === thread.id,
			},
		}));

		const inputAnnotations: DiffLineAnnotation<ThreadMeta>[] = [];
		for (const [, pending] of pendingInputs) {
			inputAnnotations.push({
				side: pending.side,
				lineNumber: pending.lineNo,
				metadata: {
					threadId: '',
					status: '',
					messageCount: 0,
					isExpanded: false,
					isInputActive: true,
					isReplying: false,
				},
			});
		}

		return [...threadAnnotations, ...inputAnnotations];
	});

	const threadById = $derived.by((): Record<string, CommentThread> => {
		const result: Record<string, CommentThread> = {};
		for (const t of fileThreads) result[t.id] = t;
		return result;
	});

	const threadMessagesMap = $derived.by((): Record<string, ThreadMessage[]> => {
		const result: Record<string, ThreadMessage[]> = {};
		for (const t of fileThreads) result[t.id] = getThreadMessages(t.id);
		return result;
	});

	// ── Comment handlers ────────────────────────────────────────────────────────

	function handleLineClick(lineNumber: number, side: 'deletions' | 'additions') {
		const key = `${lineNumber}::${side}`;
		if (pendingInputs.has(key)) {
			pendingInputs.delete(key);
			return;
		}
		pendingInputs.set(key, { side, lineNo: lineNumber });
	}

	function handleAnnotationToggle(threadId: string) {
		if (expandedThreadIds.has(threadId)) {
			expandedThreadIds.delete(threadId);
			if (replyingThreadId === threadId) replyingThreadId = null;
		} else {
			expandedThreadIds.add(threadId);
		}
	}

	function handleReplyToggle(threadId: string) {
		replyingThreadId = replyingThreadId === threadId ? null : threadId;
		if (replyingThreadId === threadId) {
			expandedThreadIds.add(threadId);
		}
	}

	async function handleReplySubmit(threadId: string, body: string) {
		replyingThreadId = null;
		await addThreadMessage(threadId, {
			authorRole: 'reviewer',
			authorName: 'You',
			body,
			messageType: 'reply',
		});
	}

	async function handleCommentSubmit(
		lineNo: number,
		side: 'deletions' | 'additions',
		body: string,
	) {
		const key = `${lineNo}::${side}`;
		pendingInputs.delete(key);

		const result = await addThread({
			filePath: block.filePath,
			startLine: lineNo,
			endLine: lineNo,
			diffSide: side === 'deletions' ? 'old' : 'new',
			message: {
				authorRole: 'reviewer',
				authorName: 'You',
				body,
				messageType: 'comment',
			},
		});

		if (result) {
			expandedThreadIds.add(result.thread.id);
		}
	}

	function handleCommentDismiss(lineNo: number) {
		for (const k of [...pendingInputs.keys()]) {
			if (k.startsWith(`${lineNo}::`)) {
				pendingInputs.delete(k);
			}
		}
	}

	async function handleCommentResolve(threadId: string) {
		await resolveThread(threadId);
	}

	async function handleCommentReopen(threadId: string) {
		await reopenThread(threadId);
	}

	// ── Diff instance ───────────────────────────────────────────────────────────

	let diffInstance = $state.raw<FileDiff<ThreadMeta> | null>(null);

	function mountDiffBlock(el: HTMLDivElement) {
		const options: FileDiffOptions<ThreadMeta> = {
			diffStyle: 'unified',
			theme: { dark: 'pierre-dark', light: 'pierre-light' },
			themeType,
			overflow: 'scroll',
			enableGutterUtility: true,
			lineHoverHighlight: 'both',

			onLineClick(props) {
				handleLineClick(props.lineNumber, props.annotationSide);
			},

			renderAnnotation(annotation) {
				const meta = annotation.metadata;
				if (!meta) return undefined;

				const host = document.createElement('div');
				host.style.cssText = 'display:block;width:100%;';

				if (meta.isInputActive) {
					annotationScope.mountInto(host, AnnotationCommentInput, {
						filePath: block.filePath,
						lineNo: annotation.lineNumber,
						onSubmit: (body: string) => {
							handleCommentSubmit(
								annotation.lineNumber,
								annotation.side,
								body,
							);
						},
						onDismiss: () => {
							handleCommentDismiss(annotation.lineNumber);
						},
					});
				} else if (meta.isExpanded) {
					const thread = threadById[meta.threadId];
					const messages = threadMessagesMap[meta.threadId] ?? [];
					if (!thread) return host;

					annotationScope.mountInto(host, AnnotationThread, {
						thread,
						messages,
						onReply: () => {
							handleReplyToggle(meta.threadId);
						},
						onResolve: () => {
							handleCommentResolve(meta.threadId);
						},
						onReopen: () => {
							handleCommentReopen(meta.threadId);
						},
						onCollapse: () => {
							handleAnnotationToggle(meta.threadId);
						},
						isReplying: meta.isReplying,
						onReplySubmit: (body: string) => {
							handleReplySubmit(meta.threadId, body);
						},
						onReplyDismiss: () => {
							handleReplyToggle(meta.threadId);
						},
					});
				} else {
					// Collapsed thread dot indicator
					const dot = document.createElement('span');
					const isResolved =
						meta.status === 'resolved' || meta.status === 'wont_fix';
					const isPending =
						meta.status === 'pending_coder' ||
						meta.status === 'pending_reviewer';
					const color = isResolved
						? '#3f3f46'
						: isPending
							? '#f59e0b'
							: '#3b82f6';
					dot.style.cssText = `display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:50%;background:${color}22;border:1.5px solid ${color};cursor:pointer;margin:4px;`;
					const inner = document.createElement('span');
					inner.style.cssText = `display:block;width:6px;height:6px;border-radius:50%;background:${color};`;
					dot.appendChild(inner);
					dot.addEventListener('click', () => {
						handleAnnotationToggle(meta.threadId);
					});
					host.appendChild(dot);
				}

				return host;
			},
		};

		const instance = new FileDiff<ThreadMeta>(options, workerManager);

		// Build a full patch string with diff header
		const patchHeader = [
			`diff --git a/${block.filePath} b/${block.filePath}`,
			`--- a/${block.filePath}`,
			`+++ b/${block.filePath}`,
		].join('\n');
		const fullPatch = `${patchHeader}\n${block.patch}`;
		const patches = parsePatchFiles(fullPatch);
		const parsed = patches[0]?.files[0];

		if (!parsed) {
			el.textContent = 'Failed to parse diff';
			return { destroy() {} };
		}

		instance.render({
			containerWrapper: el,
			fileDiff: parsed,
			lineAnnotations: annotations,
		});
		diffInstance = instance;

		return {
			destroy() {
				annotationScope.cleanupAll();
				instance.cleanUp();
				diffInstance = null;
			},
		};
	}

	// Re-render annotations when comment state changes
	$effect(() => {
		if (!diffInstance) return;
		const currentAnnotations = annotations;
		diffInstance.setLineAnnotations(currentAnnotations);
	});

	onDestroy(() => {
		annotationScope.cleanupAll();
		try {
			diffInstance?.cleanUp();
		} catch { /* ignore */ }
		diffInstance = null;
	});
</script>

<div class="annotated-block" class:annotated-block--no-annotation={!block.annotation} class:animate={animateEntrance}>
	{#if block.annotation && block.annotationPosition === 'left'}
		<div class="annotation annotation--left">
			<div class="annotation-content">
				{@html renderedAnnotation}
			</div>
		</div>
	{/if}

	<div class="diff-panel">
		<div class="diff-header">
			<span class="diff-file-path">{block.filePath}</span>
		</div>
		<div class="diff-body" use:mountDiffBlock></div>
	</div>

	{#if block.annotation && block.annotationPosition === 'right'}
		<div class="annotation annotation--right">
			<div class="annotation-content">
				{@html renderedAnnotation}
			</div>
		</div>
	{/if}
</div>

<style>
	.annotated-block {
		display: grid;
		grid-template-columns: 1fr 1fr;
		border: 1px solid var(--rev-border);
		border-radius: 10px;
		overflow: hidden;
		container-type: inline-size;
	}

	.annotated-block.animate {
		animation: block-enter 0.3s ease-out;
	}

	.annotated-block--no-annotation {
		grid-template-columns: 1fr;
	}

	.annotation {
		display: flex;
		align-items: center;
		padding: 16px 20px;
		background: var(--rev-bg-secondary);
		font-size: 13px;
		line-height: 1.6;
		color: var(--rev-text-secondary);
	}

	.annotation--left {
		border-right: 2px solid var(--rev-accent);
	}

	.annotation--right {
		border-left: 2px solid var(--rev-accent);
	}

	.annotation-content {
		width: 100%;
	}

	.annotation-content :global(p) {
		margin: 0 0 8px;
	}

	.annotation-content :global(p:last-child) {
		margin-bottom: 0;
	}

	.annotation-content :global(code) {
		font-family: var(--font-mono);
		font-size: 11px;
		background: var(--rev-bg-tertiary);
		padding: 1px 4px;
		border-radius: 3px;
	}

	.annotation-content :global(strong) {
		color: var(--rev-text-primary);
		font-weight: 600;
	}

	.diff-panel {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.diff-header {
		display: flex;
		align-items: center;
		background: var(--rev-diff-bg);
		border-bottom: 1px solid var(--rev-diff-gutter-border);
		padding: 6px 12px;
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--rev-text-muted);
	}

	.diff-file-path {
		font-weight: 500;
		color: var(--rev-text-secondary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.diff-body {
		overflow: hidden;
	}

	/* Narrow: stack vertically */
	@container (max-width: 600px) {
		.annotated-block {
			grid-template-columns: 1fr;
		}

		.annotation--left {
			border-right: none;
			border-bottom: 2px solid var(--rev-accent);
		}

		.annotation--right {
			border-left: none;
			border-top: 2px solid var(--rev-accent);
		}
	}

	@keyframes block-enter {
		from {
			opacity: 0;
			transform: translateY(8px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}
</style>
