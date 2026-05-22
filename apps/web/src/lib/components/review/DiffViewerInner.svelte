<script lang="ts" module>
// ── ThreadMeta ─────────────────────────────────────────────────────────────
// Exported so DiffViewer can import and use the same type.
export interface ThreadMeta {
  threadId: string;
  status: string;
  messageCount: number;
  isExpanded: boolean;
  isInputActive: boolean;
  isReplying: boolean;
  isPending: boolean;
}
</script>

<script lang="ts">
	import {
		DIFFS_TAG_NAME,
		FileDiff,
		HEADER_METADATA_SLOT_ID,
		HEADER_PREFIX_SLOT_ID,
		parsePatchFiles,
		type DiffLineAnnotation,
		type FileDiffMetadata,
		type FileDiffOptions,
		type DiffTokenEventBaseProps
	} from '@pierre/diffs';
	import type { ReviewFile, CommentThread, ThreadMessage } from '$lib/types/review';
	import { workerManager } from '$lib/utils/worker-pool';
	import { onMount, onDestroy } from 'svelte';
	import { mountInto, cleanupAllMounted } from '$lib/utils/annotation-mount';
	import {
		ANNOTATION_HOST_STYLE,
		createMarkerDot,
		mountAnnotationThread
	} from './annotation-renderers';
	import AnnotationCommentInput from './AnnotationCommentInput.svelte';
	import type { LineClickInfo } from './DiffViewer.svelte';
	import {
		getActivePanel,
		getCursorLineIndex,
		getCursorSide,
		getAnchorLineIndex,
		setTotalLineCount,
		isInLineCursorMode
	} from '$lib/stores/focus-mode.svelte';
	import { countPatchLines } from '$lib/utils/count-patch-lines';
	import { getPendingDiffJump, clearPendingDiffJump } from '$lib/stores/review.svelte';

	// ── Token hover info ──────────────────────────────────────────────────────

	export interface TokenHoverInfo {
		tokenText: string;
		lineNumber: number;
		side: string;
		element: HTMLElement;
	}

	// ── Props ─────────────────────────────────────────────────────────────────

	interface Props {
		file: ReviewFile;
		mode: 'unified' | 'split';
		annotations: DiffLineAnnotation<ThreadMeta>[];
		/** Map from threadId → messages, for expanded thread rendering */
		threadMessages: Record<string, ThreadMessage[]>;
		/** Map from threadId → CommentThread, for expanded thread rendering */
		threadById: Record<string, CommentThread>;
		onLineClick?: ((info: LineClickInfo) => void) | undefined;
		onModeChange?: ((mode: 'unified' | 'split') => void) | undefined;
		onAnnotationToggle?: ((threadId: string) => void) | undefined;
		onReplyToggle?: ((threadId: string) => void) | undefined;
		onReplySubmit?: ((threadId: string, body: string) => void) | undefined;
		onCommentSubmit?: ((filePath: string, lineNo: number, side: 'deletions' | 'additions', body: string) => void) | undefined;
		onCommentDismiss?: ((filePath: string, lineNo: number) => void) | undefined;
		onCommentResolve?: ((threadId: string) => void) | undefined;
		onCommentReopen?: ((threadId: string) => void) | undefined;
		onCommentDiscard?: ((threadId: string) => void) | undefined;
		onDiscardReply?: ((threadId: string, messageId: string) => void) | undefined;
		onTokenHover?: ((info: TokenHoverInfo | null) => void) | undefined;
		onApplySuggestion?: ((threadId: string, suggestion: string) => void) | undefined;
		onEditMessage?: ((threadId: string, messageId: string, body: string) => void) | undefined;
	}

	let {
		file,
		mode,
		annotations,
		threadMessages,
		threadById,
		onLineClick,
		onModeChange,
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
		onEditMessage
	}: Props = $props();

	// ── Header DOM helpers ────────────────────────────────────────────────────
	// The library's callbacks must return light-DOM Elements.  These helpers keep
	// the option-object readable by separating construction from composition.

	const SVG_UNIFIED = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="3.5" y1="4.5" x2="12.5" y2="4.5"/><line x1="3.5" y1="8" x2="12.5" y2="8"/><line x1="3.5" y1="11.5" x2="12.5" y2="11.5"/></svg>`;
	const SVG_SPLIT = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="2" y="2.5" width="12" height="11" rx="1.5"/><line x1="8" y1="2.5" x2="8" y2="13.5"/></svg>`;

	function buildViewModePill(
		currentMode: 'unified' | 'split',
		onChange: ((mode: 'unified' | 'split') => void) | undefined
	): HTMLElement {
		function makeBtn(svg: string, label: string, active: boolean): HTMLElement {
			const btn = document.createElement('div');
			btn.innerHTML = svg;
			btn.title = label;
			btn.setAttribute('role', 'button');
			btn.setAttribute('aria-label', label);
			btn.dataset.viewBtn = active ? 'active' : '';
			return btn;
		}

		const pill = document.createElement('div');
		pill.dataset.viewPill = '';

		const unifiedBtn = makeBtn(SVG_UNIFIED, 'Unified view', currentMode === 'unified');
		const splitBtn = makeBtn(SVG_SPLIT, 'Split view', currentMode === 'split');

		unifiedBtn.addEventListener('click', (e) => { e.stopPropagation(); onChange?.('unified'); });
		splitBtn.addEventListener('click', (e) => { e.stopPropagation(); onChange?.('split'); });

		const sep = document.createElement('div');
		sep.dataset.viewSep = '';

		pill.appendChild(unifiedBtn);
		pill.appendChild(sep);
		pill.appendChild(splitBtn);
		return pill;
	}

	// ── Base shadow-DOM CSS (always injected) ─────────────────────────────────
	const BASE_CSS = `[data-diffs-header='default'] { position: static !important; }`;

	// ── Header slot population (SSR-hydrate path) ─────────────────────────────
	// Pierre's `hydrate` doesn't run renderHeaderPrefix / renderHeaderMetadata
	// — only `render` does. After hydrate we recreate the slot DIVs the lib
	// would have appended (FileDiff.js:622-655) so the file-status badge and
	// the unified/split toggle pill appear inside the SSR'd header.
	function populateHeaderSlots(
		hostEl: HTMLElement,
		fileDiff: FileDiffMetadata,
		opts: FileDiffOptions<ThreadMeta>
	): void {
		function appendSlot(
			slotName: string,
			content: string | number | Element | null | undefined
		): void {
			if (content == null) return;
			const slotEl = document.createElement('div');
			slotEl.slot = slotName;
			if (content instanceof Element) slotEl.appendChild(content);
			else slotEl.innerText = String(content);
			hostEl.appendChild(slotEl);
		}
		appendSlot(HEADER_PREFIX_SLOT_ID, opts.renderHeaderPrefix?.(fileDiff));
		appendSlot(HEADER_METADATA_SLOT_ID, opts.renderHeaderMetadata?.(fileDiff));
	}

	// ── Local state ───────────────────────────────────────────────────────────

	let wrapperEl: HTMLDivElement | null = null;
	let instance = $state.raw<FileDiff<ThreadMeta> | null>(null);
	let error = $state<string | null>(null);
	/** Reference to the original options object for setOptions() merging. */
	let initialOptions: FileDiffOptions<ThreadMeta> | null = null;
	/**
	 * Last annotations reference that has been applied to the FileDiff instance
	 * — either by the initial render()/hydrate() in onMount, or by the
	 * annotations $effect below. Used as a guard so the $effect skips its
	 * eager initial run (which would re-render with forceRender:true and wipe
	 * the SSR-hydrated tokens, forcing a cold worker tokenization).
	 */
	let appliedAnnotations: DiffLineAnnotation<ThreadMeta>[] | null = null;
	let appliedThreadById: Record<string, CommentThread> | null = null;
	let appliedThreadMessages: Record<string, ThreadMessage[]> | null = null;

	/**
	 * Mutable reference that renderAnnotation reads from. This avoids the
	 * stale-closure problem: the callback is defined once in onMount but
	 * needs to see the latest threadById / threadMessages when threads load
	 * asynchronously after the initial render.
	 */
	const threadDataRef = {
		threadById: {} as Record<string, CommentThread>,
		threadMessages: {} as Record<string, ThreadMessage[]>,
	};

	// Note: $effect blocks that guard on `!instance` or `!initialOptions` rely on
	// Svelte 5's ordering guarantee that onMount runs before $effects first execute.
	// This is intentional — do not make instance $state (it would deep-proxy a large object).

	function captureEl(el: HTMLDivElement) {
		wrapperEl = el;
		return {
			destroy() {
				wrapperEl = null;
			}
		};
	}

	// ── Shadow DOM helpers ────────────────────────────────────────────────────

	/** Walk children looking for an element with a shadowRoot. */
	function findShadowHost(container: HTMLElement): HTMLElement | null {
		for (const child of container.children) {
			if (child instanceof HTMLElement && child.shadowRoot) return child;
		}
		for (const child of container.children) {
			if (child instanceof HTMLElement) {
				for (const grandchild of child.children) {
					if (grandchild instanceof HTMLElement && grandchild.shadowRoot) return grandchild;
				}
			}
		}
		return null;
	}

	function getShadowRoot(): ShadowRoot | null {
		if (!wrapperEl) return null;
		const host = findShadowHost(wrapperEl);
		return host?.shadowRoot ?? null;
	}

	/**
	 * Given a patch string and a target new-file line number, return the
	 * 0-based `data-line-index` of the closest non-deletion line in the patch.
	 */
	function findPatchLineIndex(patch: string, targetLine: number): number | null {
		const lines = patch.split('\n');
		let patchLineIdx = 0;
		let newLineNum = 0;
		let bestIdx: number | null = null;

		for (const raw of lines) {
			if (raw.startsWith('@@')) {
				// Parse hunk header: @@ -old,count +new,count @@
				const m = /\+(\d+)/.exec(raw);
				if (m?.[1]) {
					newLineNum = parseInt(m[1], 10) - 1;
				}
				// hunk headers don't get a data-line-index slot
				continue;
			}
			if (raw.startsWith('-')) {
				// deletion — advances no new line number, but does occupy a patch line index
				patchLineIdx++;
				continue;
			}
			// context or addition
			patchLineIdx++;
			newLineNum++;
			if (newLineNum >= targetLine) {
				return patchLineIdx - 1;
			}
			bestIdx = patchLineIdx - 1;
		}
		return bestIdx;
	}

	// ─ Reactive updates ──────────────────────────────────────────────────────
	// Re-render when thread data changes. The reference-equality guard skips
	// the eager initial $effect run — at that point onMount has already rendered
	// via render()/hydrate(). When threads load asynchronously, threadById,
	// threadMessages, and annotations all get new references, triggering this
	// effect. We update the mutable ref (so renderAnnotation sees fresh data),
	// clear stale caches, and re-render with the new annotations.
	$effect(() => {
		if (!instance) return;
		const currentAnnotations = annotations;
		const currentThreadById = threadById;
		const currentThreadMessages = threadMessages;
		if (
			currentAnnotations === appliedAnnotations &&
			currentThreadById === appliedThreadById &&
			currentThreadMessages === appliedThreadMessages
		) return;
		appliedAnnotations = currentAnnotations;
		appliedThreadById = currentThreadById;
		appliedThreadMessages = currentThreadMessages;

		// Update mutable ref so renderAnnotation callback (defined once in
		// onMount) reads fresh thread data.
		threadDataRef.threadById = currentThreadById;
		threadDataRef.threadMessages = currentThreadMessages;

		// Clear annotation cache — the library caches DOM elements by annotation
		// object reference. Without clearing, stale elements with empty thread
		// data persist even after threadDataRef is updated.
		// @ts-expect-error annotationCache is protected
		instance.annotationCache?.clear();

		// Clear header slots before re-render to prevent badge duplication.
		// The library's applyHeaderToDOM reuses slot elements by reference; if
		// the header HTML is regenerated (forceRender), old slot refs point to
		// removed DOM nodes, causing new slots to be created alongside them.
		// @ts-expect-error clearHeaderSlots is protected
		instance.clearHeaderSlots?.();

		// Re-render with new annotations. Must pass lineAnnotations so the
		// library updates its internal state and creates annotation rows.
		instance.render({ lineAnnotations: currentAnnotations, forceRender: true });
	});

	// ── Line cursor highlight (diff-line mode) ────────────────────────────────
	$effect(() => {
		if (!instance || !initialOptions) return;
		const panel = getActivePanel();
		const lineIdx = getCursorLineIndex();

		if (panel === 'diff-line') {
			const css = `${BASE_CSS} [data-line-index="${lineIdx}"] { background-color: var(--color-tree-active-bg) !important; outline: 1px solid color-mix(in srgb, var(--color-accent) 25%, transparent); outline-offset: -1px; }`;
			instance.setOptions({ ...initialOptions, unsafeCSS: css });
		} else if (panel !== 'diff-visual') {
			// Clear highlight when not in line/visual mode
			// (visual mode uses setSelectedLines instead)
			instance.setOptions({ ...initialOptions, unsafeCSS: BASE_CSS });
		}
	});

	// ── Scroll active line into view ──────────────────────────────────────────
	$effect(() => {
		if (!isInLineCursorMode()) return;
		const lineIdx = getCursorLineIndex();

		requestAnimationFrame(() => {
			const shadowRoot = getShadowRoot();
			if (!shadowRoot) return;
			const lineEl = shadowRoot.querySelector<HTMLElement>(`[data-line-index="${lineIdx}"]`);
			if (lineEl) {
				lineEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
			}
		});
	});

	// ── Walkthrough → diff jump ───────────────────────────────────────────────
	$effect(() => {
		const jump = getPendingDiffJump();
		if (!jump || jump.filePath !== file.path || !file.patch) return;

		// Clear first — instance is $state.raw so this effect won't re-run for it;
		// clearing early prevents another instance from picking up the same jump
		clearPendingDiffJump();

		if (!instance) return;

		const patchLineIdx = findPatchLineIndex(file.patch, jump.lineNumber);
		if (patchLineIdx === null) return;

		setTimeout(() => {
			requestAnimationFrame(() => {
				const shadowRoot = getShadowRoot();
				if (!shadowRoot) return;
				const lineEl = shadowRoot.querySelector<HTMLElement>(`[data-line-index="${patchLineIdx}"]`);
				if (lineEl) {
					lineEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
				}
			});
		}, 50);
	});

	// ── Visual line selection (diff-visual mode) ──────────────────────────────
	$effect(() => {
		if (!instance) return;
		const panel = getActivePanel();

		if (panel === 'diff-visual') {
			const cursor = getCursorLineIndex();
			const anchor = getAnchorLineIndex();
			if (anchor === null) return;

			const start = Math.min(anchor, cursor);
			const end = Math.max(anchor, cursor);
			const side = getCursorSide();

			// With exactOptionalPropertyTypes, omit side entirely when null
			const range = side !== null
				? { start, end, side, endSide: side }
				: { start, end };

			instance.setSelectedLines(range);
			// Clear unsafeCSS line highlight — selection replaces it
			if (initialOptions) {
				instance.setOptions({ ...initialOptions, unsafeCSS: BASE_CSS });
			}
		} else {
			// Clear selection when leaving visual mode
			instance.setSelectedLines(null);
		}
	});

	// ── Instance lifecycle ────────────────────────────────────────────────────

	onMount(() => {
		if (!wrapperEl) return;

		try {
			const options: FileDiffOptions<ThreadMeta> = {
				diffStyle: mode,
				theme: { dark: 'pierre-dark', light: 'pierre-light' },
				overflow: 'scroll',
				expansionLineCount: 20,
				collapsedContextThreshold: 3,
				diffIndicators: 'bars',
				expandUnchanged: true,
				lineHoverHighlight: 'both',
				enableGutterUtility: true,
				enableLineSelection: true,
				unsafeCSS: BASE_CSS,

				// ── Hunk separators: Pierre's built-in line-info renders the
				// "@@ -X,Y +A,B @@" range, an expand-up / expand-down button,
				// and uses container queries (gated on this exact value) to size
				// itself inside a constrained parent.
				hunkSeparators: 'line-info',

				// ── Header: file status badge ──────────────────────────────────
				renderHeaderPrefix(fileDiff) {
					const wrap = document.createElement('span');
					wrap.style.cssText = 'display:flex;align-items:center;gap:6px;';

					const type = fileDiff.type;
					if (
						type === 'new' ||
						type === 'deleted' ||
						type === 'rename-pure' ||
						type === 'rename-changed'
					) {
						const badge = document.createElement('span');
						const label =
							type === 'new' ? 'new' : type === 'deleted' ? 'deleted' : 'renamed';
					const color =
						type === 'new'
							? 'var(--color-success)'
							: type === 'deleted'
								? 'var(--color-danger)'
								: 'var(--color-warning)';
						badge.textContent = label;
						badge.style.cssText = `font-size:9px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;background:color-mix(in srgb, ${color} 13%, transparent);color:${color};border-radius:3px;padding:1px 5px;`;
						wrap.appendChild(badge);
					}

					return wrap;
				},

				// ── Header: unified/split icon pill toggle ──────────────────────
				renderHeaderMetadata(_fileDiff) {
					return buildViewModePill(mode, onModeChange);
				},

				// ── Token hover ────────────────────────────────────────────────
				onTokenEnter(props: DiffTokenEventBaseProps) {
					onTokenHover?.({
						tokenText: props.tokenText,
						lineNumber: props.lineNumber,
						side: props.side,
						element: props.tokenElement
					});
				},
				onTokenLeave() {
					onTokenHover?.(null);
				},

				// ── Line click → bubble up ─────────────────────────────────────
				onLineClick(props) {
					if (!onLineClick) return;
					const code = props.lineElement?.textContent ?? '';
					const rect = props.lineElement?.getBoundingClientRect() ?? new DOMRect();
					onLineClick({
						filePath: file.path,
						lineNumber: props.lineNumber,
						side: props.annotationSide,
						lineType: props.lineType,
						code,
						rect
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
							filePath: file.path,
							lineNo: annotation.lineNumber,
							onSubmit: (body: string) => {
								onCommentSubmit?.(
									file.path,
									annotation.lineNumber,
									annotation.side,
									body
								);
							},
							onDismiss: () => {
								onCommentDismiss?.(file.path, annotation.lineNumber);
							}
						});
					} else if (meta.isExpanded) {
						// Read from mutable ref so we always see latest thread data
						// even though this callback was defined once in onMount.
						const thread = threadDataRef.threadById[meta.threadId];
						const messages = threadDataRef.threadMessages[meta.threadId] ?? [];
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
							onEditMessage
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
				}
			};

			instance = new FileDiff<ThreadMeta>(options, workerManager);
			// Store reference for setOptions() merging
			initialOptions = options;

			// Update threadDataRef BEFORE render/hydrate so renderAnnotation
			// callback sees current thread data on the initial render.
			threadDataRef.threadById = threadById;
			threadDataRef.threadMessages = threadMessages;

			// Parse the git patch string directly — this preserves the exact
			// additions/deletions counts from GitHub's diff, so the library's
			// header stats match the file tree without any overrides.
			const patchHeader = [
				`diff --git a/${file.oldPath ?? file.path} b/${file.path}`,
				...(file.isNew ? ['new file mode 100644'] : []),
				...(file.isDeleted ? ['deleted file mode 100644'] : []),
				`--- ${file.isNew ? '/dev/null' : `a/${file.oldPath ?? file.path}`}`,
				`+++ ${file.isDeleted ? '/dev/null' : `b/${file.path}`}`,
			].join('\n');
			const fullPatch = file.patch
				? `${patchHeader}\n${file.patch}`
				: patchHeader;
			const patches = parsePatchFiles(fullPatch);
			const parsed = patches[0]?.files[0];
			if (!parsed) {
				error = 'Failed to parse patch';
				return;
			}

			// SSR-hydrate only when the server has prerendered HTML for unified
			// mode (the server doesn't know the user's mode preference; split
			// always falls through to render()). Hydrate skips the worker
			// tokenize round-trip — the diff body paints synchronously and
			// interaction managers attach to the existing DOM.
			//
			// Pierre's `hydrate` doesn't invoke `renderHeaderPrefix` /
			// `renderHeaderMetadata` (only `render` does). So we manually
			// populate the header slots after hydrate using the exported slot
			// IDs — Pierre's shadow DOM has `<slot name="...">` placeholders
			// that project these light-DOM children.
			if (file.prerenderedHtml !== undefined && mode === 'unified') {
				// Match the render() DOM structure: a <diffs-container> custom element
				// as the shadow host inside wrapperEl. The tag name matters — app.css
				// :900 overrides `diffs-container { color-scheme: inherit }` so Pierre's
				// `light-dark()` token colors follow <html>'s theme instead of the OS.
				// A plain <div> would skip that rule and produce mismatched colors
				// (light tokens on a dark app background) for the entire SSR-visible
				// window — until the worker re-render replaces them.
				const hostEl = document.createElement(DIFFS_TAG_NAME);
				wrapperEl.appendChild(hostEl);
				instance.hydrate({
					fileContainer: hostEl,
					prerenderedHTML: file.prerenderedHtml,
					fileDiff: parsed,
					lineAnnotations: annotations,
				});
				populateHeaderSlots(hostEl, parsed, options);
			} else {
				instance.render({
					containerWrapper: wrapperEl,
					fileDiff: parsed,
					lineAnnotations: annotations,
					forceRender: true
				});
			}
			// Mark initial state as applied so the post-mount $effect
			// (which would otherwise re-render with forceRender:true) is a no-op.
			appliedAnnotations = annotations;
			appliedThreadById = threadById;
			appliedThreadMessages = threadMessages;

			// Set total line count for keyboard cursor navigation
			if (file.patch) {
				setTotalLineCount(countPatchLines(file.patch));
			}

		} catch (e) {
			console.error('[DiffViewerInner] Render error:', e);
			error = e instanceof Error ? e.message : String(e);
		}
	});

	onDestroy(() => {
		cleanupAllMounted();
		try {
			instance?.cleanUp();
		} catch {
			// ignore cleanup errors
		}
		instance = null;
	});
</script>

{#if error}
	<div class="diff-error">
		<p>Failed to render diff</p>
		<pre>{error}</pre>
	</div>
{/if}
<div use:captureEl class="diff-inner"></div>

<style>
	.diff-inner {
		min-height: 100%;
		width: 100%;
		--diffs-gap-inline: 8px;
		--diffs-tab-size: 2;
		--diffs-min-number-column-width: 2ch;
	}

	.diff-error {
		padding: 16px;
		color: var(--color-danger);
		font-size: 13px;
	}

	.diff-error pre {
		margin-top: 8px;
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--color-text-muted);
		white-space: pre-wrap;
	}

	/* ── View-mode pill toggle (lives in light DOM inside diffs-container) ── */
	:global([data-view-pill]) {
		position: relative;
		display: inline-flex;
		align-items: stretch;
		border-radius: 6px;
		overflow: hidden;
		margin-left: 4px;
		vertical-align: middle;
		background: var(--color-glass-bg);
		backdrop-filter: blur(16px) saturate(1.4);
		-webkit-backdrop-filter: blur(16px) saturate(1.4);
		border: 1px solid var(--color-glass-border);
		box-shadow:
			var(--color-glass-shadow),
			inset 0 0.5px 0 0 var(--color-glass-highlight);
	}


	:global([data-view-btn]) {
		position: relative;
		z-index: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 26px;
		padding: 4px 0;
		cursor: pointer;
		color: var(--color-text-secondary);
		transition: background-color var(--duration-instant) var(--ease-soft);
	}

	:global([data-view-btn]:hover) {
		background-color: var(--color-glass-highlight);
	}

	:global([data-view-btn='active']) {
		background-color: var(--color-glass-active-bg);
	}

	:global([data-view-btn='active']:hover) {
		background-color: var(--color-glass-active-bg);
	}

	:global([data-view-sep]) {
		position: relative;
		z-index: 1;
		width: 1px;
		flex-shrink: 0;
		background-color: var(--color-glass-border);
	}

</style>
