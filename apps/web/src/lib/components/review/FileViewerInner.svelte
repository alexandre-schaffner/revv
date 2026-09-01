<script lang="ts" module>
// ── TokenHoverInfo ─────────────────────────────────────────────────────────
export interface TokenHoverInfo {
  tokenText: string;
  lineNumber: number;
  element: HTMLElement;
}
</script>

<script lang="ts">
	// Forked from DiffViewerInner.svelte. Differences:
	//   - Pierre `File` instead of `FileDiff` (no patch parsing, no hunk
	//     separators, no view-mode pill).
	//   - `LineAnnotation<T>` instead of `DiffLineAnnotation<T>` — Pierre's
	//     non-diff annotations don't carry an `annotationSide` field, so the
	//     thread store hard-codes `diffSide: 'new'` for any comments left
	//     here (the file IS the head revision).
	//   - No `setSelectedLines` (line-cursor highlight is wired the same way
	//     via `unsafeCSS` though, since Pierre's File supports the same
	//     `[data-line-index]` data attributes).
	//   - Header gets an "unchanged" badge in the prefix slot to mirror the
	//     diff viewer's "new" / "deleted" / "renamed" badges.
	import {
		File as PierreFile,
		VirtualizedFile,
		type FileOptions,
		type LineAnnotation,
		type OnLineClickProps,
		type TokenEventBase,
	} from '@pierre/diffs';
	import { PIERRE_THEME } from '@revv/shared';
	import type { CommentThread, ThreadMessage } from '$lib/types/review';
	import { workerManager } from '$lib/utils/worker-pool';
	import { onMount, onDestroy } from 'svelte';
	import { mountInto, cleanupAllMounted } from '$lib/utils/annotation-mount';
	import {
		ANNOTATION_HOST_STYLE,
		createMarkerDot,
		mountAnnotationThread,
	} from './annotation-renderers';
	import AnnotationCommentInput from './AnnotationCommentInput.svelte';
	import {
		getActivePanel,
		getCursorLineIndex,
		setTotalLineCount,
		isInLineCursorMode,
	} from '$lib/stores/focus-mode.svelte';
	import {
		createDiffsHost,
		createHeaderBadge,
		createPierreVirtualizer,
		getPierreShadowRoot,
		PIERRE_BASE_CSS,
		type ThreadMeta
	} from './pierre-diff-adapter';

	// ── Line-click info bubbled to the wrapper ─────────────────────────────────
	// Same shape as DiffViewer's `LineClickInfo`, minus the `side` field that
	// only makes sense in a diff context. Wrapper hard-codes 'new' when it
	// hands data off to `addThread`.
	export interface FileLineClickInfo {
		filePath: string;
		lineNumber: number;
		lineType: string;
		code: string;
		rect: DOMRect;
	}

	// ── Props ─────────────────────────────────────────────────────────────────

	interface Props {
		path: string;
		content: string;
		size: number;
		annotations: LineAnnotation<ThreadMeta>[];
		threadMessages: Record<string, ThreadMessage[]>;
		threadById: Record<string, CommentThread>;
		onLineClick?: ((info: FileLineClickInfo) => void) | undefined;
		onAnnotationToggle?: ((threadId: string) => void) | undefined;
		onReplyToggle?: ((threadId: string) => void) | undefined;
		onReplySubmit?: ((threadId: string, body: string) => void) | undefined;
		onCommentSubmit?: ((filePath: string, lineNo: number, body: string) => void) | undefined;
		onCommentDismiss?: ((filePath: string, lineNo: number) => void) | undefined;
		onCommentResolve?: ((threadId: string) => void) | undefined;
		onCommentReopen?: ((threadId: string) => void) | undefined;
		onCommentDiscard?: ((threadId: string) => void) | undefined;
		onDiscardReply?: ((threadId: string, messageId: string) => void) | undefined;
		onTokenHover?: ((info: TokenHoverInfo | null) => void) | undefined;
		onApplySuggestion?: ((threadId: string, suggestion: string) => void) | undefined;
		onEditMessage?: ((threadId: string, messageId: string, body: string) => void) | undefined;
		onPushThread?: ((threadId: string) => void | Promise<void>) | undefined;
		scrollRoot?: HTMLElement | null;
	}

	let {
		path,
		content,
		size,
		annotations,
		threadMessages,
		threadById,
		onLineClick,
		onAnnotationToggle,
		onReplyToggle,
		onReplySubmit,
		onCommentSubmit,
		onCommentDismiss,
		onCommentResolve,
		onCommentReopen,
		onCommentDiscard,
		onDiscardReply,
		onTokenHover,
		onApplySuggestion,
		onEditMessage,
		onPushThread,
		scrollRoot = null,
	}: Props = $props();

	function formatSize(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}

	// ── Local state ──────────────────────────────────────────────────────────

	let wrapperEl: HTMLDivElement | null = null;
	let instance = $state.raw<PierreFile<ThreadMeta> | VirtualizedFile<ThreadMeta> | null>(null);
	let error = $state<string | null>(null);
	let initialOptions: FileOptions<ThreadMeta> | null = null;
	let virtualizer = $state.raw<ReturnType<typeof createPierreVirtualizer> | null>(null);

	function captureEl(el: HTMLDivElement) {
		wrapperEl = el;
		return {
			destroy() {
				wrapperEl = null;
			},
		};
	}

	// ── Shadow DOM helpers (line-cursor scroll) ──────────────────────────────

	function getShadowRoot(): ShadowRoot | null {
		return getPierreShadowRoot(wrapperEl);
	}

	// ── Reactive updates ─────────────────────────────────────────────────────

	$effect(() => {
		if (!instance) return;
		const currentAnnotations = annotations;
		// Pierre's File.render requires `file` on every call (unlike FileDiff
		// which allows omitting `fileDiff` for pure annotation updates). The
		// render is internally cache-keyed by name+contents, so re-passing
		// the same payload is cheap.
		instance.render({
			file: { name: path, contents: content },
			lineAnnotations: currentAnnotations,
			forceRender: true,
		});
	});

	// Line cursor highlight (diff-line mode) — same pattern as
	// DiffViewerInner. Pierre's File renderer also stamps `data-line-index`
	// on each line, so the unsafeCSS trick works identically.
	$effect(() => {
		if (!instance || !initialOptions) return;
		const panel = getActivePanel();
		const lineIdx = getCursorLineIndex();

		if (panel === 'diff-line') {
			const css =
				`${PIERRE_BASE_CSS} [data-line-index="${lineIdx}"] { ` +
				`background-color: var(--color-tree-active-bg) !important; ` +
				`outline: 1px solid color-mix(in srgb, var(--color-accent) 25%, transparent); ` +
				`outline-offset: -1px; ` +
				`}`;
			instance.setOptions({ ...initialOptions, unsafeCSS: css });
		} else if (panel !== 'diff-visual') {
			instance.setOptions({ ...initialOptions, unsafeCSS: PIERRE_BASE_CSS });
		}
	});

	$effect(() => {
		if (!isInLineCursorMode()) return;
		const lineIdx = getCursorLineIndex();
		requestAnimationFrame(() => {
			const shadowRoot = getShadowRoot();
			if (!shadowRoot) return;
			const lineEl = shadowRoot.querySelector<HTMLElement>(
				`[data-line-index="${lineIdx}"]`
			);
			if (lineEl) lineEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
		});
	});

	// Re-render on file swap (path or content change). Pierre's render is
	// idempotent — passing the same payload twice no-ops via internal caching.
	$effect(() => {
		if (!instance) return;
		void path;
		void content;
		instance.render({
			file: { name: path, contents: content },
			lineAnnotations: annotations,
		});
	});

	// ── Instance lifecycle ───────────────────────────────────────────────────

	onMount(() => {
		if (!wrapperEl) return;

		try {
			const options: FileOptions<ThreadMeta> = {
				theme: PIERRE_THEME,
				overflow: 'scroll',
				lineHoverHighlight: 'both',
				enableGutterUtility: true,
				enableLineSelection: true,
				unsafeCSS: PIERRE_BASE_CSS,

				// ── Header: "unchanged" badge ─────────────────────────────────
				// Mirrors DiffViewerInner's renderHeaderPrefix shape so the
				// header element stack inside Pierre's shadow root looks
				// identical between diff and non-diff views.
				renderHeaderPrefix(_file) {
					const wrap = document.createElement('span');
					wrap.style.cssText = 'display:flex;align-items:center;gap:6px;';

					const color = 'var(--color-text-muted)';
					wrap.appendChild(createHeaderBadge('unchanged', color));

					return wrap;
				},

				// ── Header metadata: file size ────────────────────────────────
				// Sits in the same right-hand slot as the diff viewer's
				// view-mode pill / additions-deletions counts.
				renderCustomMetadata(_file) {
					if (size <= 0) return null;
					const span = document.createElement('span');
					span.textContent = formatSize(size);
					span.style.cssText = 'font-size:11px;color:var(--color-text-muted);';
					return span;
				},

				// ── Token hover ────────────────────────────────────────────────
				onTokenEnter(props: TokenEventBase) {
					onTokenHover?.({
						tokenText: props.tokenText,
						lineNumber: props.lineNumber,
						element: props.tokenElement,
					});
				},
				onTokenLeave() {
					onTokenHover?.(null);
				},

				// ── Line click → bubble up ─────────────────────────────────────
				onLineClick(props: OnLineClickProps) {
					if (!onLineClick) return;
					const code = props.lineElement?.textContent ?? '';
					const rect = props.lineElement?.getBoundingClientRect() ?? new DOMRect();
					onLineClick({
						filePath: path,
						lineNumber: props.lineNumber,
						lineType: 'line',
						code,
						rect,
					});
				},

				// ── Annotation rendering ───────────────────────────────────────
				renderAnnotation(annotation) {
					const meta = annotation.metadata;
					if (!meta) return undefined;

					const host = document.createElement('div');
					host.style.cssText = ANNOTATION_HOST_STYLE;

					if (meta.isInputActive) {
						mountInto(host, AnnotationCommentInput, {
							filePath: path,
							lineNo: annotation.lineNumber,
							onSubmit: (body: string) => {
								onCommentSubmit?.(path, annotation.lineNumber, body);
							},
							onDismiss: () => {
								onCommentDismiss?.(path, annotation.lineNumber);
							},
						});
					} else if (meta.isExpanded) {
						const thread = threadById[meta.threadId];
						const messages = threadMessages[meta.threadId] ?? [];
						if (!thread) return host;

						mountAnnotationThread(host, {
							thread,
							messages,
							threadId: meta.threadId,
							isReplying: meta.isReplying,
							isPending: meta.isPending,
							onReplyToggle,
							onCommentResolve,
							onCommentReopen,
							onCommentDiscard,
							onDiscardReply,
							onAnnotationToggle,
							onApplySuggestion,
							onReplySubmit,
							onEditMessage,
							onPushThread,
						});
					} else {
						host.appendChild(
							createMarkerDot(meta, () => onAnnotationToggle?.(meta.threadId))
						);
					}

					return host;
				},

				onPostRender(node) {
					// Pierre hardcodes `pre.tabIndex = 0` (see setWrapperNodeProps)
					// with no opt-out. We use focus-mode for line-level keyboard
					// navigation instead, so opt this pre out of the tab order.
					const pre = node.shadowRoot?.querySelector('pre');
					if (pre) pre.tabIndex = -1;
				},
			};

			virtualizer = createPierreVirtualizer(scrollRoot, wrapperEl);
			const hostEl = createDiffsHost();
			wrapperEl.appendChild(hostEl);
			instance = virtualizer
				? new VirtualizedFile<ThreadMeta>(options, virtualizer, undefined, workerManager)
				: new PierreFile<ThreadMeta>(options, workerManager);
			initialOptions = options;

			instance.render({
				fileContainer: hostEl,
				file: { name: path, contents: content },
				lineAnnotations: annotations,
			});

			// Set total line count for keyboard cursor navigation. Counted on
			// the rendered content directly — there's no patch to consult.
			const lineCount = content.split('\n').length;
			setTotalLineCount(lineCount);
		} catch (e) {
			console.error('[FileViewerInner] Render error:', e);
			error = e instanceof Error ? e.message : String(e);
		}
	});

	onDestroy(() => {
		cleanupAllMounted();
		try {
			instance?.cleanUp();
			virtualizer?.cleanUp();
		} catch {
			// ignore cleanup errors
		}
		instance = null;
		virtualizer = null;
	});
</script>

{#if error}
	<div class="file-error">
		<p>Failed to render file</p>
		<pre>{error}</pre>
	</div>
{/if}
<div use:captureEl class="file-inner"></div>

<style>
	.file-inner {
		min-height: 100%;
		width: 100%;
		--diffs-gap-inline: 8px;
		--diffs-tab-size: 2;
		--diffs-min-number-column-width: 2ch;
	}

	.file-error {
		padding: 16px;
		color: var(--color-danger);
		font-size: 13px;
	}

	.file-error pre {
		margin-top: 8px;
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--color-text-muted);
		white-space: pre-wrap;
	}
</style>
