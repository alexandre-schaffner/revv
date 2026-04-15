<script lang="ts">
	import type { DiffLineAnnotation } from '@pierre/diffs';
	import type { ReviewFile, CommentThread, ThreadMessage } from '$lib/types/review';
	import DiffViewerInner from './DiffViewerInner.svelte';
	import type { ThreadMeta, TokenHoverInfo } from './DiffViewerInner.svelte';
	import {
		getDiffMode,
		getThreadsForFile,
		getThreadMessages,
		addThread,
		resolveThread,
		acceptHunk,
		rejectHunk,
		undoHunkAction,
		getAcceptedHunks,
		getRejectedHunks,
		applyCommentSuggestion
	} from '$lib/stores/review.svelte';
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';

	// ── Re-export for consumers ───────────────────────────────────────────────

	export interface LineClickInfo {
		filePath: string;
		lineNumber: number;
		side: 'deletions' | 'additions';
		lineType: string;
		code: string;
		rect: DOMRect;
	}

	// ── Props ─────────────────────────────────────────────────────────────────

	interface Props {
		file: ReviewFile | null;
		themeType?: 'light' | 'dark' | 'system';
		onLineClick?: (info: LineClickInfo) => void;
		onModeChange?: (mode: 'unified' | 'split') => void;
		onTokenHover?: (info: TokenHoverInfo | null) => void;
	}

	let { file, themeType = 'dark', onLineClick, onModeChange, onTokenHover }: Props = $props();

	// ── Interaction state ─────────────────────────────────────────────────────

	/** Thread IDs currently expanded inline. */
	const expandedThreadIds = new SvelteSet<string>();

	/** Pending new-comment inputs keyed by `${filePath}::${lineNumber}::${side}` */
	const pendingInputs = new SvelteMap<
		string,
		{ side: 'deletions' | 'additions'; lineNo: number; code: string }
	>();

	// ── Derived values ────────────────────────────────────────────────────────

	const mode = $derived(getDiffMode());
	const acceptedHunkSet = $derived(file ? getAcceptedHunks(file.path) : new Set<number>());
	const rejectedHunkSet = $derived(file ? getRejectedHunks(file.path) : new Set<number>());

	// Key changes → Svelte destroys + recreates DiffViewerInner (full lifecycle)
	const viewKey = $derived(file ? `${file.path}::${mode}::${themeType}` : '');

	// Build annotations from current thread + pending input state
	const annotations = $derived.by((): DiffLineAnnotation<ThreadMeta>[] => {
		if (!file) return [];

		const threads = getThreadsForFile(file.path);

		// Existing thread annotations
		const threadAnnotations: DiffLineAnnotation<ThreadMeta>[] = threads.map((thread) => ({
			side: (thread.diffSide === 'old' ? 'deletions' : 'additions') as
				| 'deletions'
				| 'additions',
			lineNumber: thread.startLine,
			metadata: {
				threadId: thread.id,
				status: thread.status,
				messageCount: getThreadMessages(thread.id).length,
				isExpanded: expandedThreadIds.has(thread.id),
				isInputActive: false
			}
		}));

		// Pending new-comment inputs
		const inputAnnotations: DiffLineAnnotation<ThreadMeta>[] = [];
		for (const [key, pending] of pendingInputs) {
			const [pendingFilePath] = key.split('::');
			if (pendingFilePath !== file.path) continue;
			inputAnnotations.push({
				side: pending.side,
				lineNumber: pending.lineNo,
				metadata: {
					threadId: '',
					status: '',
					messageCount: 0,
					isExpanded: false,
					isInputActive: true
				}
			});
		}

		return [...threadAnnotations, ...inputAnnotations];
	});

	// Build threadById / threadMessages lookup maps for DiffViewerInner
	const threadById = $derived.by((): Record<string, CommentThread> => {
		if (!file) return {};
		const result: Record<string, CommentThread> = {};
		for (const t of getThreadsForFile(file.path)) {
			result[t.id] = t;
		}
		return result;
	});

	const threadMessages = $derived.by((): Record<string, ThreadMessage[]> => {
		if (!file) return {};
		const result: Record<string, ThreadMessage[]> = {};
		for (const t of getThreadsForFile(file.path)) {
			result[t.id] = getThreadMessages(t.id);
		}
		return result;
	});

	// ── Handlers ──────────────────────────────────────────────────────────────

	function handleLineClick(info: LineClickInfo) {
		if (!file) return;

		const key = `${info.filePath}::${info.lineNumber}::${info.side}`;

		// Toggle: clicking the same line again dismisses the input
		if (pendingInputs.has(key)) {
			pendingInputs.delete(key);
			return;
		}

		// Open new comment input for this line
		pendingInputs.set(key, {
			side: info.side,
			lineNo: info.lineNumber,
			code: info.code
		});

		onLineClick?.(info);
	}

	function handleAnnotationToggle(threadId: string) {
		if (expandedThreadIds.has(threadId)) {
			expandedThreadIds.delete(threadId);
		} else {
			expandedThreadIds.add(threadId);
		}
	}

	async function handleCommentSubmit(
		filePath: string,
		lineNo: number,
		side: 'deletions' | 'additions',
		body: string
	) {
		const key = `${filePath}::${lineNo}::${side}`;

		// Remove pending input immediately for responsiveness
		pendingInputs.delete(key);

		const result = await addThread({
			filePath,
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

	function handleCommentDismiss(filePath: string, lineNo: number) {
		// Remove all pending inputs for this file+line (any side)
		for (const k of [...pendingInputs.keys()]) {
			if (k.startsWith(`${filePath}::${lineNo}::`)) {
				pendingInputs.delete(k);
			}
		}
	}

	async function handleCommentResolve(threadId: string) {
		await resolveThread(threadId);
	}

	async function handleHunkAccept(filePath: string, hunkIndex: number) {
		await acceptHunk(filePath, hunkIndex);
	}

	async function handleHunkReject(filePath: string, hunkIndex: number) {
		await rejectHunk(filePath, hunkIndex);
	}

	async function handleHunkUndo(filePath: string, hunkIndex: number) {
		await undoHunkAction(filePath, hunkIndex);
	}

	async function handleApplySuggestion(threadId: string, suggestion: string) {
		await applyCommentSuggestion(threadId, suggestion);
	}
</script>

{#if file}
	{#key viewKey}
		<DiffViewerInner
			{file}
			{mode}
			{themeType}
			{annotations}
			{threadMessages}
			{threadById}
			acceptedHunks={acceptedHunkSet}
			rejectedHunks={rejectedHunkSet}
			onLineClick={handleLineClick}
			{onModeChange}
			onAnnotationToggle={handleAnnotationToggle}
			onCommentSubmit={handleCommentSubmit}
			onCommentDismiss={handleCommentDismiss}
			onCommentResolve={handleCommentResolve}
			onHunkAccept={handleHunkAccept}
			onHunkReject={handleHunkReject}
			onHunkUndo={handleHunkUndo}
			{onTokenHover}
			onApplySuggestion={handleApplySuggestion}
		/>
	{/key}
{/if}
