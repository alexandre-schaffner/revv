<script lang="ts">
	import type { DiffLineAnnotation } from '@pierre/diffs';
	import type { ReviewFile, CommentThread, ThreadMessage } from '$lib/types/review';
	import DiffViewerInner from './DiffViewerInner.svelte';
	import type { ThreadMeta, TokenHoverInfo } from './DiffViewerInner.svelte';
	import {
		getDiffMode,
		getThreadsForFile,
		getThreadMessages,
		getThreadsVersion,
		addThread,
		addThreadMessage,
		resolveThread,
		reopenThread,
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
		/** When set, triggers opening a comment input at the given line range. */
		commentTrigger?: { startLine: number; endLine: number; side: 'additions' | 'deletions'; seq: number } | null;
	}

	let { file, themeType = 'dark', onLineClick, onModeChange, onTokenHover, commentTrigger = null }: Props = $props();

	// ── Interaction state ─────────────────────────────────────────────────────

	/** Thread IDs currently expanded inline. */
	const expandedThreadIds = new SvelteSet<string>();

	/** The thread currently showing a reply input (only one at a time). */
	let replyingThreadId = $state<string | null>(null);

	/** Pending new-comment inputs keyed by `${filePath}::${lineNumber}::${side}` */
	const pendingInputs = new SvelteMap<
		string,
		{ side: 'deletions' | 'additions'; lineNo: number; code: string }
	>();

	/** Stores the endLine for pending comment inputs, keyed the same way as pendingInputs. */
	const pendingEndLines = new SvelteMap<string, number>();

	// ── Derived values ────────────────────────────────────────────────────────

	const mode = $derived(getDiffMode());

	// Key changes → Svelte destroys + recreates DiffViewerInner (full lifecycle)
	const viewKey = $derived(file ? `${file.path}::${mode}::${themeType}` : '');

	// Build annotations from current thread + pending input state
	const annotations = $derived.by((): DiffLineAnnotation<ThreadMeta>[] => {
		// Subscribe to the threads-version signal so this derivation recomputes on
		// every thread mutation. @pierre/diffs caches annotations by metadata
		// reference, so we must hand it a freshly-constructed annotation array.
		getThreadsVersion();
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
				isInputActive: false,
				isReplying: replyingThreadId === thread.id
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
					isInputActive: true,
					isReplying: false
				}
			});
		}

		return [...threadAnnotations, ...inputAnnotations];
	});

	// Build threadById / threadMessages lookup maps for DiffViewerInner
	const threadById = $derived.by((): Record<string, CommentThread> => {
		getThreadsVersion();
		if (!file) return {};
		const result: Record<string, CommentThread> = {};
		for (const t of getThreadsForFile(file.path)) {
			result[t.id] = t;
		}
		return result;
	});

	const threadMessages = $derived.by((): Record<string, ThreadMessage[]> => {
		getThreadsVersion();
		if (!file) return {};
		const result: Record<string, ThreadMessage[]> = {};
		for (const t of getThreadsForFile(file.path)) {
			result[t.id] = getThreadMessages(t.id);
		}
		return result;
	});

	// ── Handlers ──────────────────────────────────────────────────────────────

	// Watch for external comment trigger (from keyboard shortcuts in ReviewLayout)
	$effect(() => {
		const trigger = commentTrigger;
		if (!trigger || !file) return;
		const key = `${file.path}::${trigger.startLine}::${trigger.side}`;
		pendingInputs.set(key, { side: trigger.side, lineNo: trigger.startLine, code: '' });
	});

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
			// Clear reply state when collapsing
			if (replyingThreadId === threadId) replyingThreadId = null;
		} else {
			expandedThreadIds.add(threadId);
		}
	}

	function handleReplyToggle(threadId: string) {
		replyingThreadId = replyingThreadId === threadId ? null : threadId;
		// Ensure thread is expanded when reply input is opened
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
		filePath: string,
		lineNo: number,
		side: 'deletions' | 'additions',
		body: string
	) {
		const key = `${filePath}::${lineNo}::${side}`;

		// Remove pending input immediately for responsiveness
		pendingInputs.delete(key);
		const endLine = pendingEndLines.get(key) ?? lineNo;
		pendingEndLines.delete(key);

		const result = await addThread({
			filePath,
			startLine: lineNo,
			endLine,
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
				pendingEndLines.delete(k);
			}
		}
	}

	async function handleCommentResolve(threadId: string) {
		await resolveThread(threadId);
	}

	async function handleCommentReopen(threadId: string) {
		await reopenThread(threadId);
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
			onLineClick={handleLineClick}
			{onModeChange}
			onAnnotationToggle={handleAnnotationToggle}
			onReplyToggle={handleReplyToggle}
			onReplySubmit={handleReplySubmit}
			onCommentSubmit={handleCommentSubmit}
			onCommentDismiss={handleCommentDismiss}
			onCommentResolve={handleCommentResolve}
			onCommentReopen={handleCommentReopen}
			{onTokenHover}
			onApplySuggestion={handleApplySuggestion}
		/>
	{/key}
{/if}
