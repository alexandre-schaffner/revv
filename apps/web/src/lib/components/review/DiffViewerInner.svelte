<script lang="ts" module>
	// ── ThreadMeta ─────────────────────────────────────────────────────────────
	// Exported so DiffViewer can import and use the same type.
	export interface ThreadMeta {
		threadId: string;
		status: string;
		messageCount: number;
		isExpanded: boolean;
		isInputActive: boolean;
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
	import { getOrCreateWorkerPoolSingleton } from '@pierre/diffs/worker';
	import type { ReviewFile, CommentThread, ThreadMessage } from '$lib/types/review';
	import { onMount, onDestroy } from 'svelte';
	import { mountInto, cleanupAllMounted } from '$lib/utils/annotation-mount';
	import AnnotationThread from './AnnotationThread.svelte';
	import AnnotationCommentInput from './AnnotationCommentInput.svelte';
	import type { LineClickInfo } from './DiffViewer.svelte';

	// ── Worker pool ───────────────────────────────────────────────────────────
	// Module-level singleton — created once, shared across all FileDiff instances.
	const workerManager =
		typeof window !== 'undefined'
			? getOrCreateWorkerPoolSingleton({
					poolOptions: {
						workerFactory: () =>
							new Worker(
								new URL(
									'@pierre/diffs/worker/worker-portable.js',
									import.meta.url
								),
								{ type: 'module' }
							),
						poolSize: 2
					},
					highlighterOptions: {
						langs: [
							'typescript',
							'javascript',
							'svelte',
							'css',
							'json',
							'python',
							'go',
							'rust',
							'html',
							'shellscript',
							'yaml',
							'sql'
						],
						theme: { dark: 'pierre-dark', light: 'pierre-light' }
					}
				})
			: undefined;

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
		/** Set of hunk indices that have been accepted */
		acceptedHunks: Set<number>;
		/** Set of hunk indices that have been rejected */
		rejectedHunks: Set<number>;
		onLineClick?: ((info: LineClickInfo) => void) | undefined;
		onModeChange?: ((mode: 'unified' | 'split') => void) | undefined;
		onAnnotationToggle?: ((threadId: string) => void) | undefined;
		onCommentSubmit?: ((filePath: string, lineNo: number, side: 'deletions' | 'additions', body: string) => void) | undefined;
		onCommentDismiss?: ((filePath: string, lineNo: number) => void) | undefined;
		onCommentResolve?: ((threadId: string) => void) | undefined;
		onHunkAccept?: ((filePath: string, hunkIndex: number) => void) | undefined;
		onHunkReject?: ((filePath: string, hunkIndex: number) => void) | undefined;
		onHunkUndo?: ((filePath: string, hunkIndex: number) => void) | undefined;
		onTokenHover?: ((info: TokenHoverInfo | null) => void) | undefined;
		onApplySuggestion?: ((threadId: string, suggestion: string) => void) | undefined;
	}

	let {
		file,
		mode,
		themeType,
		annotations,
		threadMessages,
		threadById,
		acceptedHunks,
		rejectedHunks,
		onLineClick,
		onModeChange,
		onAnnotationToggle,
		onCommentSubmit,
		onCommentDismiss,
		onCommentResolve,
		onHunkAccept,
		onHunkReject,
		onHunkUndo,
		onTokenHover,
		onApplySuggestion
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

	// ── Local state ───────────────────────────────────────────────────────────

	let wrapperEl: HTMLDivElement | null = null;
	let instance = $state.raw<FileDiff<ThreadMeta> | null>(null);
	let error = $state<string | null>(null);

	// Mutable container so the hunkSeparators closure always reads fresh state.
	const hunkState = { accepted: new Set<number>(), rejected: new Set<number>() };

	function captureEl(el: HTMLDivElement) {
		wrapperEl = el;
		return {
			destroy() {
				wrapperEl = null;
			}
		};
	}

	// ── Reactive updates ──────────────────────────────────────────────────────
	// Unified effect for annotation + hunk decision changes.  Updating
	// `hunkState` ensures the `hunkSeparators` closure sees the latest
	// accepted/rejected sets on the next render.
	$effect(() => {
		if (!instance) return;
		const currentAnnotations = annotations;

		// Refresh the mutable container so the separator closure reads fresh data.
		hunkState.accepted = acceptedHunks;
		hunkState.rejected = rejectedHunks;

		// forceRender ensures hunkSeparators are regenerated with new state.
		instance.render({ lineAnnotations: currentAnnotations, forceRender: true });
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

				// ── Hunk separators with accept/reject buttons ─────────────────
				// Reads from `hunkState` (mutated by the $effect) so the closure
				// always reflects the latest accepted/rejected decisions.
				hunkSeparators(hunk: HunkData, _inst) {
					const frag = document.createDocumentFragment();
					const isAccepted = hunkState.accepted.has(hunk.hunkIndex);
					const isRejected = hunkState.rejected.has(hunk.hunkIndex);
					const hasDecision = isAccepted || isRejected;

					const row = document.createElement('div');
					row.dataset.hunkIndex = String(hunk.hunkIndex);
					row.style.cssText = [
						'display:flex',
						'align-items:center',
						'padding:0 10px',
						'min-height:28px',
						'gap:6px',
						'font-size:11px',
						'color:var(--color-text-muted,#888)',
						'font-family:var(--font-mono,monospace)',
						'border-top:1px solid var(--color-border-subtle,#2a2a32)',
						'border-bottom:1px solid var(--color-border-subtle,#2a2a32)',
						isAccepted
							? 'background:rgba(34,197,94,0.06)'
							: isRejected
								? 'background:rgba(239,68,68,0.06)'
								: 'background:var(--color-bg-secondary,#13131a)',
					].join(';');

					const label = document.createElement('span');
					label.textContent = `@@ hunk ${hunk.hunkIndex + 1}`;
					label.style.cssText = 'flex:1;';
					row.appendChild(label);

					if (hasDecision) {
						// ── Decided state: status badge + undo ──────────────────
						const badge = document.createElement('span');
						badge.textContent = isAccepted ? '✓ Accepted' : '✕ Rejected';
						const badgeColor = isAccepted ? '#22c55e' : '#ef4444';
						badge.style.cssText = [
							'font-size:10px',
							'font-weight:600',
							`color:${badgeColor}`,
						].join(';');
						row.appendChild(badge);

						const undoBtn = document.createElement('button');
						undoBtn.textContent = 'Undo';
						undoBtn.title = `Undo decision for hunk ${hunk.hunkIndex + 1}`;
						undoBtn.style.cssText = [
							'font-size:10px',
							'font-weight:500',
							'border:1px solid var(--color-border-subtle,#2a2a32)',
							'background:transparent',
							'color:var(--color-text-muted,#888)',
							'border-radius:3px',
							'padding:1px 7px',
							'cursor:pointer',
							'transition:background-color 80ms,color 80ms',
						].join(';');
						undoBtn.addEventListener('mouseenter', () => {
							undoBtn.style.background = 'rgba(255,255,255,0.06)';
							undoBtn.style.color = 'var(--color-text-secondary,#aaa)';
						});
						undoBtn.addEventListener('mouseleave', () => {
							undoBtn.style.background = 'transparent';
							undoBtn.style.color = 'var(--color-text-muted,#888)';
						});
						undoBtn.addEventListener('click', (e) => {
							e.stopPropagation();
							onHunkUndo?.(file.path, hunk.hunkIndex);
						});
						row.appendChild(undoBtn);
					} else {
						// ── Undecided: accept / reject buttons ──────────────────
						const acceptBtn = document.createElement('button');
						acceptBtn.textContent = '✓ Accept';
						acceptBtn.title = `Accept hunk ${hunk.hunkIndex + 1}`;
						acceptBtn.style.cssText = [
							'font-size:10px',
							'font-weight:500',
							'border:1px solid rgba(34,197,94,0.3)',
							'background:rgba(34,197,94,0.08)',
							'color:#22c55e',
							'border-radius:3px',
							'padding:1px 7px',
							'cursor:pointer',
							'transition:background-color 80ms',
						].join(';');
						acceptBtn.addEventListener('mouseenter', () => {
							acceptBtn.style.background = 'rgba(34,197,94,0.18)';
						});
						acceptBtn.addEventListener('mouseleave', () => {
							acceptBtn.style.background = 'rgba(34,197,94,0.08)';
						});
						acceptBtn.addEventListener('click', (e) => {
							e.stopPropagation();
							onHunkAccept?.(file.path, hunk.hunkIndex);
						});
						row.appendChild(acceptBtn);

						const rejectBtn = document.createElement('button');
						rejectBtn.textContent = '✕ Reject';
						rejectBtn.title = `Reject hunk ${hunk.hunkIndex + 1}`;
						rejectBtn.style.cssText = [
							'font-size:10px',
							'font-weight:500',
							'border:1px solid rgba(239,68,68,0.3)',
							'background:rgba(239,68,68,0.08)',
							'color:#ef4444',
							'border-radius:3px',
							'padding:1px 7px',
							'cursor:pointer',
							'transition:background-color 80ms',
						].join(';');
						rejectBtn.addEventListener('mouseenter', () => {
							rejectBtn.style.background = 'rgba(239,68,68,0.18)';
						});
						rejectBtn.addEventListener('mouseleave', () => {
							rejectBtn.style.background = 'rgba(239,68,68,0.08)';
						});
						rejectBtn.addEventListener('click', (e) => {
							e.stopPropagation();
							onHunkReject?.(file.path, hunk.hunkIndex);
						});
						row.appendChild(rejectBtn);
					}

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
								? '#22c55e'
								: type === 'deleted'
									? '#ef4444'
									: '#f59e0b';
						badge.textContent = label;
						badge.style.cssText = `font-size:9px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;background:${color}22;color:${color};border-radius:3px;padding:1px 5px;`;
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
								onAnnotationToggle?.(meta.threadId);
							},
							onResolve: () => {
								onCommentResolve?.(meta.threadId);
							},
							onCollapse: () => {
								onAnnotationToggle?.(meta.threadId);
							},
							onApplySuggestion: (suggestion: string) =>
								onApplySuggestion?.(meta.threadId, suggestion)
						});
					} else {
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

			// Parse the git patch string directly — this preserves the exact
			// additions/deletions counts from GitHub's diff, so the library's
			// header stats match the file tree without any overrides.
			const patchHeader = [
				`diff --git a/${file.oldPath ?? file.path} b/${file.path}`,
				`--- a/${file.oldPath ?? file.path}`,
				`+++ b/${file.path}`,
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
		display: inline-flex;
		align-items: stretch;
		border-radius: 6px;
		overflow: hidden;
		margin-left: 4px;
		vertical-align: middle;
		border: 1px solid var(--color-border);
	}

	:global([data-view-btn]) {
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
		background-color: var(--color-bg-secondary);
	}

	:global([data-view-btn='active']) {
		background-color: var(--color-bg-tertiary);
	}

	:global([data-view-btn='active']:hover) {
		background-color: var(--color-bg-tertiary);
	}

	:global([data-view-sep]) {
		width: 1px;
		flex-shrink: 0;
		background-color: var(--color-border);
	}
</style>
