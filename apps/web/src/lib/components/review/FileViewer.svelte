<script lang="ts">
	// Forked from DiffViewer.svelte. Same thread-state machinery wired to the
	// same review.svelte store; the only deltas vs the diff path are:
	//   - hands its inner `FileViewerInner` raw content + path instead of a
	//     parsed patch
	//   - LineAnnotation has no `side` (Pierre's File annotations are
	//     single-column), so all comments are stored with diffSide='new'
	//   - placeholder states (loading / binary / too-large / not-found / error)
	//     short-circuit before we mount the inner component
	import type { LineAnnotation } from '@pierre/diffs';
	import type { CommentThread, ThreadMessage } from '$lib/types/review';
	import FileViewerInner from './FileViewerInner.svelte';
	import type { ThreadMeta, TokenHoverInfo, FileLineClickInfo } from './FileViewerInner.svelte';
	import {
		getThreadsForFile,
		getThreadMessages,
		getThreadsVersion,
		addThread,
		addThreadMessage,
		resolveThread,
		reopenThread,
		deleteThread,
		deleteThreadMessage,
		applyCommentSuggestion,
		editThreadMessage,
	} from '$lib/stores/review.svelte';
	import { getUser } from '$lib/stores/auth.svelte';
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';

	// ── Props ─────────────────────────────────────────────────────────────────

	interface Props {
		path: string;
		content: string;
		isBinary: boolean;
		size: number;
		status: 'idle' | 'loading' | 'ready' | 'binary' | 'too-large' | 'not-found' | 'error';
		errorMessage?: string | null;
		onTokenHover?: (info: TokenHoverInfo | null) => void;
	}

	let {
		path,
		content,
		isBinary,
		size,
		status,
		errorMessage = null,
		onTokenHover,
	}: Props = $props();

	function formatSize(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}

	// ── Interaction state — copied verbatim from DiffViewer ──────────────────

	const expandedThreadIds = new SvelteSet<string>();
	let replyingThreadId = $state<string | null>(null);

	/** Pending new-comment inputs keyed by `${path}::${lineNumber}::new`.
	 *  The 'new' suffix is hard-coded — a non-diff file has no old/new
	 *  side, but we keep the key shape DiffViewer uses for symmetry. */
	const pendingInputs = new SvelteMap<string, { lineNo: number }>();

	// ── Derived ──────────────────────────────────────────────────────────────

	// Re-mount the inner component on path change so Pierre's File instance
	// always matches what we're showing.
	const viewKey = $derived(`${path}`);

	const annotations = $derived.by((): LineAnnotation<ThreadMeta>[] => {
		// Subscribe to the threads-version signal so this rebuilds on every
		// thread mutation. Pierre caches annotations by metadata reference,
		// so we must hand it a freshly-constructed array on each mutation.
		getThreadsVersion();

		const threads = getThreadsForFile(path);

		const threadAnnotations: LineAnnotation<ThreadMeta>[] = threads.map(
			(thread) => ({
				lineNumber: thread.startLine,
				metadata: {
					threadId: thread.id,
					status: thread.status,
					messageCount: getThreadMessages(thread.id).length,
					isExpanded: expandedThreadIds.has(thread.id),
					isInputActive: false,
					isReplying: replyingThreadId === thread.id,
					isPending: thread.externalCommentId == null,
				},
			}),
		);

		const inputAnnotations: LineAnnotation<ThreadMeta>[] = [];
		for (const [_key, pending] of pendingInputs) {
			inputAnnotations.push({
				lineNumber: pending.lineNo,
				metadata: {
					threadId: '',
					status: '',
					messageCount: 0,
					isExpanded: false,
					isInputActive: true,
					isReplying: false,
					isPending: false,
				},
			});
		}

		return [...threadAnnotations, ...inputAnnotations];
	});

	const threadById = $derived.by((): Record<string, CommentThread> => {
		getThreadsVersion();
		const result: Record<string, CommentThread> = {};
		for (const t of getThreadsForFile(path)) result[t.id] = t;
		return result;
	});

	const threadMessages = $derived.by((): Record<string, ThreadMessage[]> => {
		getThreadsVersion();
		const result: Record<string, ThreadMessage[]> = {};
		for (const t of getThreadsForFile(path)) {
			result[t.id] = getThreadMessages(t.id);
		}
		return result;
	});

	// ── Handlers — copied verbatim from DiffViewer (modulo the missing
	//    `side` field which we hard-code to 'new' on the way to the store). ──

	function pendingKey(lineNo: number): string {
		return `${path}::${lineNo}::new`;
	}

	function handleLineClick(info: FileLineClickInfo) {
		const key = pendingKey(info.lineNumber);

		// Toggle: clicking the same line again dismisses the input.
		if (pendingInputs.has(key)) {
			pendingInputs.delete(key);
			return;
		}

		pendingInputs.clear();
		pendingInputs.set(key, { lineNo: info.lineNumber });
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
		if (replyingThreadId === threadId) expandedThreadIds.add(threadId);
	}

	async function handleReplySubmit(threadId: string, body: string) {
		replyingThreadId = null;
		const u = getUser();
		const authorName = u?.githubLogin ?? u?.name ?? 'You';
		const authorAvatarUrl = u?.image ?? null;
		await addThreadMessage(threadId, {
			authorRole: 'reviewer',
			authorName,
			authorAvatarUrl,
			body,
			messageType: 'reply',
		});
	}

	async function handleCommentSubmit(filePath: string, lineNo: number, body: string) {
		const key = pendingKey(lineNo);
		pendingInputs.delete(key);

		const u = getUser();
		const authorName = u?.githubLogin ?? u?.name ?? 'You';
		const authorAvatarUrl = u?.image ?? null;

		const result = await addThread({
			filePath,
			startLine: lineNo,
			endLine: lineNo,
			diffSide: 'new',
			message: {
				authorRole: 'reviewer',
				authorName,
				authorAvatarUrl,
				body,
				messageType: 'comment',
			},
		});

		if (result) expandedThreadIds.add(result.thread.id);
	}

	function handleCommentDismiss(_filePath: string, lineNo: number) {
		pendingInputs.delete(pendingKey(lineNo));
	}

	async function handleCommentResolve(threadId: string) {
		await resolveThread(threadId);
	}

	async function handleCommentReopen(threadId: string) {
		await reopenThread(threadId);
	}

	async function handleCommentDiscard(threadId: string) {
		await deleteThread(threadId);
	}

	async function handleDiscardReply(threadId: string, messageId: string) {
		await deleteThreadMessage(threadId, messageId);
	}

	async function handleApplySuggestion(threadId: string, suggestion: string) {
		await applyCommentSuggestion(threadId, suggestion);
	}

	async function handleEditMessage(threadId: string, messageId: string, body: string) {
		await editThreadMessage(threadId, messageId, body);
	}
</script>

<!--
	No outer wrapper / padding — the title is rendered by ReviewLayout (same
	as the diff path) and the inner viewer fills the pane edge-to-edge so
	Pierre's gutter, font, and header card stretch to the same width as the
	diff view.
-->
{#if status === 'loading'}
	<div class="placeholder">Loading file contents…</div>
{:else if status === 'binary' || isBinary}
	<div class="placeholder placeholder--info">
		<p class="placeholder-title">Binary file</p>
		<p class="placeholder-text">{formatSize(size)} · contents not shown</p>
	</div>
{:else if status === 'too-large'}
	<div class="placeholder placeholder--info">
		<p class="placeholder-title">File too large to preview</p>
		<p class="placeholder-text">{formatSize(size)}</p>
	</div>
{:else if status === 'not-found'}
	<div class="placeholder placeholder--error">
		<p class="placeholder-title">File not found</p>
		<p class="placeholder-text">This path doesn't exist at the PR's head SHA.</p>
	</div>
{:else if status === 'error'}
	<div class="placeholder placeholder--error">
		<p class="placeholder-title">Couldn't load file</p>
		<p class="placeholder-text">{errorMessage ?? 'Unknown error'}</p>
	</div>
{:else}
	{#key viewKey}
		<FileViewerInner
			{path}
			{content}
			{size}
			{annotations}
			{threadMessages}
			{threadById}
			onLineClick={handleLineClick}
			onAnnotationToggle={handleAnnotationToggle}
			onReplyToggle={handleReplyToggle}
			onReplySubmit={handleReplySubmit}
			onCommentSubmit={handleCommentSubmit}
			onCommentDismiss={handleCommentDismiss}
			onCommentResolve={handleCommentResolve}
			onCommentReopen={handleCommentReopen}
			onCommentDiscard={handleCommentDiscard}
			onDiscardReply={handleDiscardReply}
			{onTokenHover}
			onApplySuggestion={handleApplySuggestion}
			onEditMessage={handleEditMessage}
		/>
	{/key}
{/if}

<style>
	.placeholder {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 8px;
		padding: 64px 32px;
		text-align: center;
	}

	.placeholder-title {
		font-size: 14px;
		font-weight: 600;
		color: var(--color-text-secondary);
		margin: 0;
	}

	.placeholder-text {
		font-size: 12px;
		color: var(--color-text-muted);
		margin: 0;
	}

	.placeholder--error .placeholder-title {
		color: var(--color-danger);
	}
</style>
