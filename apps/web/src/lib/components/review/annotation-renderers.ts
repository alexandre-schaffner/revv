/**
 * Shared DOM/mount helpers for @pierre/diffs renderAnnotation callbacks.
 * Centralizes the host wrapper, the collapsed-state marker dot, and the
 * AnnotationThread prop bundle so DiffViewer and FileViewer stay in sync.
 */
import type { CommentThread, ThreadMessage } from '@revv/shared';
import { mountInto } from '$lib/utils/annotation-mount';
import AnnotationThread from './AnnotationThread.svelte';

export const ANNOTATION_HOST_STYLE = 'display:block;max-width:720px;margin:8px 0 8px 16px;';

/**
 * Create the collapsed marker dot — the colored ring shown on a diff line
 * when its thread is not expanded. Color matches thread status.
 */
export function createMarkerDot(
	meta: { status: string },
	onClick: () => void
): HTMLElement {
	const isResolved = meta.status === 'resolved' || meta.status === 'wont_fix';
	const isPending =
		meta.status === 'pending_coder' || meta.status === 'pending_reviewer';
	const color = isResolved
		? 'var(--color-border)'
		: isPending
			? 'var(--color-warning)'
			: 'var(--color-accent)';

	const dot = document.createElement('span');
	dot.style.cssText =
		`display:inline-flex;align-items:center;justify-content:center;` +
		`width:16px;height:16px;border-radius:50%;` +
		`background:color-mix(in srgb, ${color} 13%, transparent);` +
		`border:1.5px solid ${color};cursor:pointer;margin:4px;`;

	const inner = document.createElement('span');
	inner.style.cssText = `display:block;width:6px;height:6px;border-radius:50%;background:${color};`;
	dot.appendChild(inner);
	dot.addEventListener('click', onClick);
	return dot;
}

export interface MountThreadArgs {
	thread: CommentThread;
	messages: ThreadMessage[];
	threadId: string;
	isReplying: boolean;
	isPending: boolean;
	onReplyToggle?: ((threadId: string) => void) | undefined;
	onCommentResolve?: ((threadId: string) => void) | undefined;
	onCommentReopen?: ((threadId: string) => void) | undefined;
	onCommentDiscard?: ((threadId: string) => void) | undefined;
	onDiscardReply?: ((threadId: string, messageId: string) => void) | undefined;
	onAnnotationToggle?: ((threadId: string) => void) | undefined;
	onApplySuggestion?: ((threadId: string, suggestion: string) => void) | undefined;
	onReplySubmit?: ((threadId: string, body: string) => void) | undefined;
	onEditMessage?:
		| ((threadId: string, messageId: string, body: string) => void)
		| undefined;
}

/**
 * Mount an AnnotationThread into the given host. Translates per-call
 * `(threadId, ...)` callbacks into the thread's argless / id-less callback
 * shape so each viewer's renderAnnotation stays focused on its own concerns.
 */
export function mountAnnotationThread(host: HTMLElement, args: MountThreadArgs): void {
	const {
		thread,
		messages,
		threadId,
		isReplying,
		isPending,
		onReplyToggle,
		onCommentResolve,
		onCommentReopen,
		onCommentDiscard,
		onDiscardReply,
		onAnnotationToggle,
		onApplySuggestion,
		onReplySubmit,
		onEditMessage,
	} = args;

	mountInto(host, AnnotationThread, {
		thread,
		messages,
		isReplying,
		isPending,
		onReply: () => onReplyToggle?.(threadId),
		onResolve: () => onCommentResolve?.(threadId),
		onReopen: () => onCommentReopen?.(threadId),
		onDiscard: () => onCommentDiscard?.(threadId),
		onDiscardReply: (messageId: string) => onDiscardReply?.(threadId, messageId),
		onCollapse: onAnnotationToggle
			? () => onAnnotationToggle(threadId)
			: undefined,
		onApplySuggestion: (suggestion: string) => onApplySuggestion?.(threadId, suggestion),
		onReplySubmit: (body: string) => onReplySubmit?.(threadId, body),
		onReplyDismiss: () => onReplyToggle?.(threadId),
		onEditMessage: (messageId: string, body: string) =>
			onEditMessage?.(threadId, messageId, body),
	});
}
