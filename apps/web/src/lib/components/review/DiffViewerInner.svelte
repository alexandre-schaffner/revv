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
		FileDiff,
		parsePatchFiles,
		type DiffLineAnnotation,
		type FileDiffOptions,
		type HunkData,
		type DiffTokenEventBaseProps
	} from '@pierre/diffs';
	import type { ReviewFile, CommentThread, ThreadMessage } from '$lib/types/review';
	import { workerManager } from '$lib/utils/worker-pool';
	import { onMount, onDestroy } from 'svelte';
	import { mountInto, cleanupAllMounted } from '$lib/utils/annotation-mount';
	import AnnotationThread from './AnnotationThread.svelte';
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
		themeType: 'light' | 'dark' | 'system';
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
		onTokenHover?: ((info: TokenHoverInfo | null) => void) | undefined;
		onApplySuggestion?: ((threadId: string, suggestion: string) => void) | undefined;
		onEditMessage?: ((threadId: string, messageId: string, body: string) => void) | undefined;
	}

	let {
		file,
		mode,
		themeType,
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

	// ── Local state ───────────────────────────────────────────────────────────

	let wrapperEl: HTMLDivElement | null = null;
	let instance = $state.raw<FileDiff<ThreadMeta> | null>(null);
	let error = $state<string | null>(null);
	/** Reference to the original options object for setOptions() merging. */
	let initialOptions: FileDiffOptions<ThreadMeta> | null = null;

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

	// ── Reactive updates ──────────────────────────────────────────────────────
	// Re-render when annotations change.
	$effect(() => {
		if (!instance) return;
		const currentAnnotations = annotations;

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

	// ── Theme sync ────────────────────────────────────────────────────────────
	$effect(() => {
		instance?.setThemeType(themeType);
	});

	// ── Instance lifecycle ────────────────────────────────────────────────────

	onMount(() => {
		if (!wrapperEl) return;

		try {
			const options: FileDiffOptions<ThreadMeta> = {
				diffStyle: mode,
				theme: { dark: 'pierre-dark', light: 'pierre-light' },
				themeType,
				overflow: 'scroll',
				expansionLineCount: 20,
				collapsedContextThreshold: 3,
				diffIndicators: 'bars',
				expandUnchanged: true,
				lineHoverHighlight: 'both',
				enableGutterUtility: true,
				enableLineSelection: true,
				unsafeCSS: BASE_CSS,

				// ── Hunk separators: minimal thin line ────────────────────────
				// Reads from `hunkState` (mutated by the $effect) so the closure
				// always reflects the latest accepted/rejected decisions.
				hunkSeparators(hunk: HunkData, _inst) {
					const frag = document.createDocumentFragment();

					const row = document.createElement('div');
					row.dataset.hunkIndex = String(hunk.hunkIndex);
					row.style.cssText = 'height:2px;width:100%;background:var(--color-border-subtle,#2a2a32)';

					frag.appendChild(row);
					return frag;
				},

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
					host.style.cssText = 'display:block;width:100%;';

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
						const thread = threadById[meta.threadId];
						const messages = threadMessages[meta.threadId] ?? [];
						if (!thread) return host;

						mountInto(host, AnnotationThread, {
						thread,
						messages,
						onReply: () => {
							onReplyToggle?.(meta.threadId);
						},
						onResolve: () => {
							onCommentResolve?.(meta.threadId);
						},
						onReopen: () => {
							onCommentReopen?.(meta.threadId);
						},
						onDiscard: () => {
							onCommentDiscard?.(meta.threadId);
						},
						onCollapse: () => {
							onAnnotationToggle?.(meta.threadId);
						},
							onApplySuggestion: (suggestion: string) =>
								onApplySuggestion?.(meta.threadId, suggestion),
							isReplying: meta.isReplying,
							isPending: meta.isPending,
							onReplySubmit: (body: string) => {
								onReplySubmit?.(meta.threadId, body);
							},
							onReplyDismiss: () => {
								onReplyToggle?.(meta.threadId);
							},
							onEditMessage: (messageId: string, body: string) => {
								onEditMessage?.(meta.threadId, messageId, body);
							},
						});
					} else {
						const dot = document.createElement('span');
						const isResolved =
							meta.status === 'resolved' || meta.status === 'wont_fix';
						const isPending =
							meta.status === 'pending_coder' ||
							meta.status === 'pending_reviewer';
					const color = isResolved
						? 'var(--color-border)'
						: isPending
							? 'var(--color-warning)'
							: 'var(--color-accent)';
					dot.style.cssText = `display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:50%;background:color-mix(in srgb, ${color} 13%, transparent);border:1.5px solid ${color};cursor:pointer;margin:4px;`;
					const inner = document.createElement('span');
					inner.style.cssText = `display:block;width:6px;height:6px;border-radius:50%;background:${color};`;
						dot.appendChild(inner);
						dot.addEventListener('click', () => {
							onAnnotationToggle?.(meta.threadId);
						});
						host.appendChild(dot);
					}

					return host;
				},

				onPostRender(node) {
					const pre = node.shadowRoot?.querySelector('pre');
					if (pre) {
						pre.removeAttribute('tabindex');
						pre.setAttribute('tabindex', '-1');
					}
				}
			};

			instance = new FileDiff<ThreadMeta>(options, workerManager);
			// Store reference for setOptions() merging
			initialOptions = options;

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

			instance.render({
				containerWrapper: wrapperEl,
				fileDiff: parsed,
				lineAnnotations: annotations,
				forceRender: true
			});

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
		transition: background-color 100ms;
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
