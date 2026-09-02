<script lang="ts">
import {
  DEFAULT_VIRTUAL_FILE_METRICS,
  type DiffLineAnnotation,
  type DiffTokenEventBaseProps,
  FileDiff,
  type FileDiffMetadata,
  type FileDiffOptions,
  getLineAnnotationName,
  parsePatchFiles,
  VirtualizedFileDiff,
} from "@pierre/diffs";
import { buildGitPatchHeader, PIERRE_THEME, PR_DIFF_RENDER_OPTIONS } from "@revv/shared";
import { onDestroy, onMount } from "svelte";
import {
  getActivePanel,
  getAnchorLineIndex,
  getCursorLineIndex,
  getCursorSide,
  isInLineCursorMode,
  setTotalLineCount,
} from "$lib/stores/focus-mode.svelte";
import { clearPendingDiffJump, getPendingDiffJump } from "$lib/stores/review.svelte";
import type { CommentThread, ReviewFile, ThreadMessage } from "$lib/types/review";
import { cleanupAllMounted, mountInto, pruneDetachedMounts } from "$lib/utils/annotation-mount";
import { countPatchLines } from "$lib/utils/count-patch-lines";
import { workerManager } from "$lib/utils/worker-pool";
import AnnotationCommentInput from "./AnnotationCommentInput.svelte";
import {
  ANNOTATION_HOST_STYLE,
  createMarkerDot,
  mountAnnotationThread,
} from "./annotation-renderers";
import type { LineClickInfo } from "./DiffViewer.svelte";
import {
  createDiffsHost,
  createHeaderBadge,
  createPierreVirtualizer,
  getPierreShadowRoot,
  PIERRE_BASE_CSS,
  populateDiffHeaderSlots,
  type ThreadMeta,
} from "./pierre-diff-adapter";

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
  mode: "unified" | "split";
  annotations: DiffLineAnnotation<ThreadMeta>[];
  /** Map from threadId → messages, for expanded thread rendering */
  threadMessages: Record<string, ThreadMessage[]>;
  /** Map from threadId → CommentThread, for expanded thread rendering */
  threadById: Record<string, CommentThread>;
  onLineClick?: ((info: LineClickInfo) => void) | undefined;
  onModeChange?: ((mode: "unified" | "split") => void) | undefined;
  onAnnotationToggle?: ((threadId: string) => void) | undefined;
  onReplyToggle?: ((threadId: string) => void) | undefined;
  onReplySubmit?: ((threadId: string, body: string) => void) | undefined;
  onCommentSubmit?:
    | ((filePath: string, lineNo: number, side: "deletions" | "additions", body: string) => void)
    | undefined;
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
  onEditMessage,
  onPushThread,
  scrollRoot = null,
}: Props = $props();

// ── Header DOM helpers ────────────────────────────────────────────────────
// The library's callbacks must return light-DOM Elements.  These helpers keep
// the option-object readable by separating construction from composition.

const SVG_UNIFIED = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="3.5" y1="4.5" x2="12.5" y2="4.5"/><line x1="3.5" y1="8" x2="12.5" y2="8"/><line x1="3.5" y1="11.5" x2="12.5" y2="11.5"/></svg>`;
const SVG_SPLIT = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="2" y="2.5" width="12" height="11" rx="1.5"/><line x1="8" y1="2.5" x2="8" y2="13.5"/></svg>`;

function buildViewModePill(
  currentMode: "unified" | "split",
  onChange: ((mode: "unified" | "split") => void) | undefined,
): HTMLElement {
  function makeBtn(svg: string, label: string, active: boolean): HTMLElement {
    const btn = document.createElement("div");
    btn.innerHTML = svg;
    btn.title = label;
    btn.setAttribute("role", "button");
    btn.setAttribute("aria-label", label);
    btn.dataset.viewBtn = active ? "active" : "";
    return btn;
  }

  const pill = document.createElement("div");
  pill.dataset.viewPill = "";

  const unifiedBtn = makeBtn(SVG_UNIFIED, "Unified view", currentMode === "unified");
  const splitBtn = makeBtn(SVG_SPLIT, "Split view", currentMode === "split");

  unifiedBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    onChange?.("unified");
  });
  splitBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    onChange?.("split");
  });

  const sep = document.createElement("div");
  sep.dataset.viewSep = "";

  pill.appendChild(unifiedBtn);
  pill.appendChild(sep);
  pill.appendChild(splitBtn);
  return pill;
}

// ── Local state ───────────────────────────────────────────────────────────

let wrapperEl: HTMLDivElement | null = null;
let instance = $state.raw<FileDiff<ThreadMeta> | VirtualizedFileDiff<ThreadMeta> | null>(null);
let error = $state<string | null>(null);
/** Reference to the original options object for setOptions() merging. */
let initialOptions: FileDiffOptions<ThreadMeta> | null = null;
let virtualizer = $state.raw<ReturnType<typeof createPierreVirtualizer> | null>(null);
let parsedFileDiff: FileDiffMetadata | null = null;
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
    },
  };
}

function getShadowRoot(): ShadowRoot | null {
  return getPierreShadowRoot(wrapperEl);
}

/**
 * True when a live annotation has no matching `<slot>` in the just-hydrated
 * shadow DOM — i.e. Pierre's `hydrate` adopted prerendered slots that don't
 * cover the current annotation set. See the hydrate call site in onMount for
 * why the prerendered and live sets diverge and what the corrective render does.
 */
function hasUnhydratedAnnotation(annos: DiffLineAnnotation<ThreadMeta>[]): boolean {
  if (annos.length === 0) return false;
  const shadowRoot = getShadowRoot();
  if (!shadowRoot) return true;
  const slotNames = new Set<string>();
  for (const slot of shadowRoot.querySelectorAll("slot[name^='annotation-']")) {
    const name = slot.getAttribute("name");
    if (name) slotNames.add(name);
  }
  return annos.some((anno) => !slotNames.has(getLineAnnotationName(anno)));
}

function findRenderedLineElement(lineIndex: number): HTMLElement | null {
  const shadowRoot = getShadowRoot();
  if (!shadowRoot) return null;
  return shadowRoot.querySelector<HTMLElement>(
    `[data-line][data-line-index="${lineIndex}"], [data-line][data-line-index^="${lineIndex},"]`,
  );
}

function getScrollTop(): number {
  return scrollRoot?.scrollTop ?? window.scrollY;
}

function getScrollViewportHeight(): number {
  return scrollRoot?.getBoundingClientRect().height ?? window.innerHeight;
}

function getElementTopInScrollRoot(element: HTMLElement): number {
  const scrollContainerTop = scrollRoot?.getBoundingClientRect().top ?? 0;
  return element.getBoundingClientRect().top - scrollContainerTop + getScrollTop();
}

function estimateDiffLineOffset(fileDiff: FileDiffMetadata, lineIndex: number): number {
  const { diffHeaderHeight, fileGap, hunkSeparatorHeight, lineHeight } =
    DEFAULT_VIRTUAL_FILE_METRICS;
  const separatorGap = fileGap;
  let separatorOffset = 0;

  for (const [hunkIndex, hunk] of fileDiff.hunks.entries()) {
    if (hunk.unifiedLineStart > lineIndex) break;
    if (hunk.collapsedBefore > 0) {
      separatorOffset += hunkSeparatorHeight + separatorGap + (hunkIndex > 0 ? separatorGap : 0);
    }
  }

  return diffHeaderHeight + separatorOffset + lineIndex * lineHeight;
}

function scrollVirtualizedLineIntoView(lineIndex: number): boolean {
  if (!virtualizer || !wrapperEl || !parsedFileDiff || !scrollRoot) return false;

  const targetTop =
    getElementTopInScrollRoot(wrapperEl) +
    estimateDiffLineOffset(parsedFileDiff, lineIndex) -
    getScrollViewportHeight() / 2;

  scrollRoot.scrollTo({ top: Math.max(0, targetTop), behavior: "auto" });
  return true;
}

function retryRenderedLineIntoView(
  lineIndex: number,
  onRendered: (() => void) | undefined,
  attemptsLeft = 6,
): void {
  requestAnimationFrame(() => {
    const lineEl = findRenderedLineElement(lineIndex);
    if (lineEl) {
      lineEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
      onRendered?.();
      return;
    }
    if (attemptsLeft > 0) retryRenderedLineIntoView(lineIndex, onRendered, attemptsLeft - 1);
  });
}

function scrollLineIntoView(lineIndex: number, onRendered?: () => void): boolean {
  const lineEl = findRenderedLineElement(lineIndex);
  if (lineEl) {
    lineEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
    onRendered?.();
    return true;
  }

  if (!scrollVirtualizedLineIntoView(lineIndex)) return false;

  retryRenderedLineIntoView(lineIndex, onRendered);
  return true;
}

/**
 * Given a patch string and a target new-file line number, return the
 * 0-based `data-line-index` of the closest non-deletion line in the patch.
 */
function findPatchLineIndex(patch: string, targetLine: number): number | null {
  const lines = patch.split("\n");
  let patchLineIdx = 0;
  let newLineNum = 0;
  let bestIdx: number | null = null;

  for (const raw of lines) {
    if (raw.startsWith("@@")) {
      // Parse hunk header: @@ -old,count +new,count @@
      const m = /\+(\d+)/.exec(raw);
      if (m?.[1]) {
        newLineNum = parseInt(m[1], 10) - 1;
      }
      // hunk headers don't get a data-line-index slot
      continue;
    }
    if (raw.startsWith("-")) {
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
//
// LOAD-BEARING: the hydrate path in onMount may deliberately leave
// `appliedAnnotations` null (when prerendered slots don't cover every live
// annotation) precisely so this guard sees a mismatch and fires one corrective
// render on first run. Don't "simplify" the guard to assume appliedAnnotations
// is always set after mount — that silently reintroduces the vanished-comment
// bug fixed in #114.
$effect(() => {
  if (!instance) return;
  const currentAnnotations = annotations;
  const currentThreadById = threadById;
  const currentThreadMessages = threadMessages;
  if (
    currentAnnotations === appliedAnnotations &&
    currentThreadById === appliedThreadById &&
    currentThreadMessages === appliedThreadMessages
  )
    return;
  appliedAnnotations = currentAnnotations;
  appliedThreadById = currentThreadById;
  appliedThreadMessages = currentThreadMessages;

  // Update mutable ref so renderAnnotation callback (defined once in
  // onMount) reads fresh thread data.
  threadDataRef.threadById = currentThreadById;
  threadDataRef.threadMessages = currentThreadMessages;

  // NOTE: do NOT clear `annotationCache` here. The library's
  // renderAnnotations() is self-cleaning — it removes the previous wrapper
  // before appending a new one whenever an annotation changed. Our store
  // hands it a fresh `metadata` object every render and the library compares
  // metadata by reference, so renderAnnotation always re-runs (picking up
  // fresh thread data) AND the old row is removed. Calling `.clear()` empties
  // the cache Map without removing the wrapper <div>s from the shadow DOM, so
  // the next render appends fresh rows alongside the orphans → duplicate
  // comments. That was the diff-tab comment-duplication bug.

  // Clear header slots before re-render to prevent badge duplication.
  // The library's applyHeaderToDOM reuses slot elements by reference; if
  // the header HTML is regenerated (forceRender), old slot refs point to
  // removed DOM nodes, causing new slots to be created alongside them.
  // @ts-expect-error clearHeaderSlots is protected
  instance.clearHeaderSlots?.();

  // Re-render with new annotations. Must pass lineAnnotations so the
  // library updates its internal state and creates annotation rows.
  instance.render({ lineAnnotations: currentAnnotations, forceRender: true });

  // The library removes the previous annotation wrappers via element.remove(),
  // but the Svelte components we mounted inside them stay registered and live.
  // Unmount the now-detached ones so their effects/listeners don't leak.
  pruneDetachedMounts();
});

// ── Line cursor highlight (diff-line mode) ────────────────────────────────
$effect(() => {
  if (!instance || !initialOptions) return;
  const panel = getActivePanel();
  const lineIdx = getCursorLineIndex();

  if (panel === "diff-line") {
    const css = `${PIERRE_BASE_CSS} [data-line-index="${lineIdx}"] { background-color: var(--color-tree-active-bg) !important; outline: 1px solid color-mix(in srgb, var(--color-accent) 25%, transparent); outline-offset: -1px; }`;
    instance.setOptions({ ...initialOptions, unsafeCSS: css });
  } else if (panel !== "diff-visual") {
    // Clear highlight when not in line/visual mode
    // (visual mode uses setSelectedLines instead)
    instance.setOptions({ ...initialOptions, unsafeCSS: PIERRE_BASE_CSS });
  }
});

// ── Scroll active line into view ──────────────────────────────────────────
$effect(() => {
  if (!isInLineCursorMode()) return;
  const lineIdx = getCursorLineIndex();

  requestAnimationFrame(() => {
    scrollLineIntoView(lineIdx);
  });
});

// ── Walkthrough → diff jump ───────────────────────────────────────────────
$effect(() => {
  const jump = getPendingDiffJump();
  if (!jump || jump.filePath !== file.path || !file.patch) return;

  if (!instance) return;

  const patchLineIdx = findPatchLineIndex(file.patch, jump.lineNumber);
  if (patchLineIdx === null) return;

  setTimeout(() => {
    requestAnimationFrame(() => {
      scrollLineIntoView(patchLineIdx, clearPendingDiffJump);
    });
  }, 50);
});

// ── Visual line selection (diff-visual mode) ──────────────────────────────
$effect(() => {
  if (!instance) return;
  const panel = getActivePanel();

  if (panel === "diff-visual") {
    const cursor = getCursorLineIndex();
    const anchor = getAnchorLineIndex();
    if (anchor === null) return;

    const start = Math.min(anchor, cursor);
    const end = Math.max(anchor, cursor);
    const side = getCursorSide();

    // With exactOptionalPropertyTypes, omit side entirely when null
    const range = side !== null ? { start, end, side, endSide: side } : { start, end };

    instance.setSelectedLines(range);
    // Clear unsafeCSS line highlight — selection replaces it
    if (initialOptions) {
      instance.setOptions({ ...initialOptions, unsafeCSS: PIERRE_BASE_CSS });
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
      ...PR_DIFF_RENDER_OPTIONS,
      diffStyle: mode,
      theme: PIERRE_THEME,
      enableGutterUtility: true,
      enableLineSelection: true,
      unsafeCSS: PIERRE_BASE_CSS,

      // ── Header: file status badge ──────────────────────────────────
      renderHeaderPrefix(fileDiff) {
        const wrap = document.createElement("span");
        wrap.style.cssText = "display:flex;align-items:center;gap:6px;";

        const type = fileDiff.type;
        if (
          type === "new" ||
          type === "deleted" ||
          type === "rename-pure" ||
          type === "rename-changed"
        ) {
          const label = type === "new" ? "new" : type === "deleted" ? "deleted" : "renamed";
          const color =
            type === "new"
              ? "var(--color-success)"
              : type === "deleted"
                ? "var(--color-danger)"
                : "var(--color-warning)";
          wrap.appendChild(createHeaderBadge(label, color));
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
          element: props.tokenElement,
        });
      },
      onTokenLeave() {
        onTokenHover?.(null);
      },

      // ── Line click → bubble up ─────────────────────────────────────
      onLineClick(props) {
        if (!onLineClick) return;
        const code = props.lineElement?.textContent ?? "";
        const rect = props.lineElement?.getBoundingClientRect() ?? new DOMRect();
        onLineClick({
          filePath: file.path,
          lineNumber: props.lineNumber,
          side: props.annotationSide,
          lineType: props.lineType,
          code,
          rect,
        });
      },

      // ── Annotation rendering ───────────────────────────────────────
      renderAnnotation(annotation) {
        const meta = annotation.metadata;
        if (!meta) return undefined;

        const host = document.createElement("div");
        host.style.cssText = ANNOTATION_HOST_STYLE;

        if (meta.isInputActive) {
          mountInto(host, AnnotationCommentInput, {
            filePath: file.path,
            lineNo: annotation.lineNumber,
            onSubmit: (body: string) => {
              onCommentSubmit?.(file.path, annotation.lineNumber, annotation.side, body);
            },
            onDismiss: () => {
              onCommentDismiss?.(file.path, annotation.lineNumber);
            },
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
            onEditMessage,
            onPushThread,
          });
        } else {
          host.appendChild(createMarkerDot(meta, () => onAnnotationToggle?.(meta.threadId)));
        }

        return host;
      },

      onPostRender(node) {
        // Pierre hardcodes `pre.tabIndex = 0` (see setWrapperNodeProps)
        // with no opt-out. We use focus-mode for line-level keyboard
        // navigation instead, so opt this pre out of the tab order.
        const pre = node.shadowRoot?.querySelector("pre");
        if (pre) pre.tabIndex = -1;
      },
    };

    // Store reference for setOptions() merging
    initialOptions = options;

    // Update threadDataRef BEFORE render/hydrate so renderAnnotation
    // callback sees current thread data on the initial render.
    threadDataRef.threadById = threadById;
    threadDataRef.threadMessages = threadMessages;

    // Parse the git patch string directly — this preserves the exact
    // additions/deletions counts from GitHub's diff, so the library's
    // header stats match the file tree without any overrides.
    const patchHeader = buildGitPatchHeader(file);
    const fullPatch = file.patch ? `${patchHeader}\n${file.patch}` : patchHeader;
    const patches = parsePatchFiles(fullPatch);
    const parsed = patches[0]?.files[0];
    if (!parsed) {
      error = "Failed to parse patch";
      return;
    }
    parsedFileDiff = parsed;

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
    if (file.prerenderedHtml !== undefined && mode === "unified") {
      instance = new FileDiff<ThreadMeta>(options, workerManager);
      // Match the render() DOM structure: a <diffs-container> custom element
      // as the shadow host inside wrapperEl. The tag name matters — app.css
      // :900 overrides `diffs-container { color-scheme: inherit }` so Pierre's
      // `light-dark()` token colors follow <html>'s theme instead of the OS.
      // A plain <div> would skip that rule and produce mismatched colors
      // (light tokens on a dark app background) for the entire SSR-visible
      // window — until the worker re-render replaces them.
      const hostEl = createDiffsHost();
      wrapperEl.appendChild(hostEl);
      instance.hydrate({
        fileContainer: hostEl,
        prerenderedHTML: file.prerenderedHtml,
        fileDiff: parsed,
        lineAnnotations: annotations,
      });
      populateDiffHeaderSlots(hostEl, parsed, options);

      // The server prerenders the unified diff's annotation slots from a
      // point-in-time thread snapshot (`/api/prs/:id/files`); the client's
      // live thread set (loaded via `/reviews/active`, and reloaded on SSE
      // without refetching files) can diverge — e.g. AI comments that land
      // after the snapshot. `hydrate` adopts the prerendered slots as-is and
      // never rebuilds the body, so those extra comments project into a
      // non-existent slot and silently vanish in unified view (split is fine —
      // it always uses the full `render()` path). When that gap exists, leave
      // appliedAnnotations null so the reconcile $effect fires exactly once and
      // rebuilds the missing slots via one corrective render(); otherwise mark
      // them applied so the $effect is a no-op and the SSR no-tokenize fast
      // paint is preserved.
      appliedAnnotations = hasUnhydratedAnnotation(annotations) ? null : annotations;
    } else {
      virtualizer = createPierreVirtualizer(scrollRoot, wrapperEl);
      const hostEl = createDiffsHost();
      wrapperEl.appendChild(hostEl);
      instance = virtualizer
        ? new VirtualizedFileDiff<ThreadMeta>(options, virtualizer, undefined, workerManager)
        : new FileDiff<ThreadMeta>(options, workerManager);
      instance.render({
        fileContainer: hostEl,
        fileDiff: parsed,
        lineAnnotations: annotations,
        forceRender: true,
      });
      // render() projected every annotation, so mark them applied to keep the
      // post-mount $effect a no-op.
      appliedAnnotations = annotations;
    }
    // Mark thread data as applied so the post-mount $effect (which would
    // otherwise re-render with forceRender:true) is a no-op. appliedAnnotations
    // is set per-branch above — the hydrate branch may leave it null on purpose
    // to trigger one corrective render.
    appliedThreadById = threadById;
    appliedThreadMessages = threadMessages;

    // Set total line count for keyboard cursor navigation
    if (file.patch) {
      setTotalLineCount(countPatchLines(file.patch));
    }
  } catch (e) {
    console.error("[DiffViewerInner] Render error:", e);
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
		/* Standing chrome: 10px blur, not 16px. */
		backdrop-filter: blur(10px) saturate(1.4);
		-webkit-backdrop-filter: blur(10px) saturate(1.4);
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

	/* inset box-shadow avoids clipping by the pill's overflow:hidden */
	:global([data-view-btn]:focus-visible) {
		box-shadow: inset 0 0 0 2px var(--color-accent);
		outline: none;
	}

	:global([data-view-sep]) {
		position: relative;
		z-index: 1;
		width: 1px;
		flex-shrink: 0;
		background-color: var(--color-glass-border);
	}

</style>
