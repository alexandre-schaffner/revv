<script lang="ts">
	import type { CodeBlock } from '@rev/shared';
	import type { CommentThread, ThreadMessage } from '$lib/types/review';
	import { File as PierreFile, type FileOptions, type LineAnnotation } from '@pierre/diffs';
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

	// ── ThreadMeta ──────────────────────────────────────────────────────────────

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
		block: CodeBlock;
		themeType: 'light' | 'dark' | 'system';
		animateEntrance?: boolean;
	}

	let { block, themeType, animateEntrance = false }: Props = $props();

	const renderedAnnotation = $derived(
		block.annotation ? renderMarkdown(block.annotation) : null
	);

	// ── Scoped annotation mounting ──────────────────────────────────────────────

	const annotationScope = createAnnotationScope();

	// ── Line number offset helpers ──────────────────────────────────────────────
	// PierreFile renders lines 1..N for the provided content. The actual file
	// line numbers are block.startLine..block.endLine. We convert at the boundary.

	function toActualLine(pierreLineNo: number): number {
		return block.startLine + pierreLineNo - 1;
	}

	function toPierreLine(actualLineNo: number): number {
		return actualLineNo - block.startLine + 1;
	}

	// ── Comment interaction state ────────────────────────────────────────────────

	const expandedThreadIds = new SvelteSet<string>();
	let replyingThreadId = $state<string | null>(null);

	/** Pending new-comment inputs keyed by actual line number */
	const pendingInputs = new SvelteMap<number, true>();

	// ── Derived annotation data ─────────────────────────────────────────────────

	/** Threads for this file, filtered to the line range of this code block */
	const blockThreads = $derived(
		getThreadsForFile(block.filePath).filter(
			(t) => t.startLine >= block.startLine && t.startLine <= block.endLine,
		),
	);

	const annotations = $derived.by((): LineAnnotation<ThreadMeta>[] => {
		const threadAnnotations: LineAnnotation<ThreadMeta>[] = blockThreads.map((thread) => ({
			lineNumber: toPierreLine(thread.startLine),
			metadata: {
				threadId: thread.id,
				status: thread.status,
				messageCount: getThreadMessages(thread.id).length,
				isExpanded: expandedThreadIds.has(thread.id),
				isInputActive: false,
				isReplying: replyingThreadId === thread.id,
			},
		}));

		const inputAnnotations: LineAnnotation<ThreadMeta>[] = [];
		for (const [actualLineNo] of pendingInputs) {
			inputAnnotations.push({
				lineNumber: toPierreLine(actualLineNo),
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
		for (const t of blockThreads) result[t.id] = t;
		return result;
	});

	const threadMessagesMap = $derived.by((): Record<string, ThreadMessage[]> => {
		const result: Record<string, ThreadMessage[]> = {};
		for (const t of blockThreads) result[t.id] = getThreadMessages(t.id);
		return result;
	});

	// ── Comment handlers ────────────────────────────────────────────────────────

	function handleLineClick(pierreLineNo: number) {
		const actualLine = toActualLine(pierreLineNo);
		if (pendingInputs.has(actualLine)) {
			pendingInputs.delete(actualLine);
			return;
		}
		pendingInputs.set(actualLine, true);
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

	async function handleCommentSubmit(actualLineNo: number, body: string) {
		pendingInputs.delete(actualLineNo);

		const result = await addThread({
			filePath: block.filePath,
			startLine: actualLineNo,
			endLine: actualLineNo,
			diffSide: 'new',
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

	function handleCommentDismiss(actualLineNo: number) {
		pendingInputs.delete(actualLineNo);
	}

	async function handleCommentResolve(threadId: string) {
		await resolveThread(threadId);
	}

	async function handleCommentReopen(threadId: string) {
		await reopenThread(threadId);
	}

	// ── File instance ───────────────────────────────────────────────────────────

	let fileInstance = $state.raw<PierreFile<ThreadMeta> | null>(null);

	function mountCodeBlock(el: HTMLDivElement) {
		const options: FileOptions<ThreadMeta> = {
			theme: { dark: 'pierre-dark', light: 'pierre-light' },
			themeType,
			overflow: 'scroll',
			enableGutterUtility: true,
			lineHoverHighlight: 'both',

			onLineClick(props) {
				handleLineClick(props.lineNumber);
			},

			renderAnnotation(annotation) {
				const meta = annotation.metadata;
				if (!meta) return undefined;

				const host = document.createElement('div');
				host.style.cssText = 'display:block;width:100%;';

				if (meta.isInputActive) {
					const actualLine = toActualLine(annotation.lineNumber);
					annotationScope.mountInto(host, AnnotationCommentInput, {
						filePath: block.filePath,
						lineNo: actualLine,
						onSubmit: (body: string) => {
							handleCommentSubmit(actualLine, body);
						},
						onDismiss: () => {
							handleCommentDismiss(actualLine);
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

		const instance = new PierreFile<ThreadMeta>(options, workerManager);
		instance.render({
			containerWrapper: el,
			file: {
				name: `${block.filePath}:${block.startLine}-${block.endLine}`,
				contents: block.content,
				lang: block.language as any,
			},
			lineAnnotations: annotations,
		});
		fileInstance = instance;

		return {
			destroy() {
				annotationScope.cleanupAll();
				instance.cleanUp();
				fileInstance = null;
			},
		};
	}

	// Re-render annotations when comment state changes
	$effect(() => {
		if (!fileInstance) return;
		const currentAnnotations = annotations;
		fileInstance.setLineAnnotations(currentAnnotations);
	});

	onDestroy(() => {
		annotationScope.cleanupAll();
		try {
			fileInstance?.cleanUp();
		} catch { /* ignore */ }
		fileInstance = null;
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

	<div class="code-panel">
		<div class="code-header">
			<span class="code-file-path">{block.filePath}</span>
			<span class="code-line-range">:{block.startLine}-{block.endLine}</span>
		</div>
		<div class="code-body" use:mountCodeBlock></div>
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

	.code-panel {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.code-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		background: var(--rev-diff-bg);
		border-bottom: 1px solid var(--rev-diff-gutter-border);
		padding: 6px 12px;
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--rev-text-muted);
	}

	.code-file-path {
		font-weight: 500;
		color: var(--rev-text-secondary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.code-line-range {
		flex-shrink: 0;
		margin-left: 8px;
	}

	.code-body {
		overflow: visible;
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
