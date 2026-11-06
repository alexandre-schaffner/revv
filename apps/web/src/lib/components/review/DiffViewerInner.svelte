<script lang="ts">
import {
  DEFAULT_VIRTUAL_FILE_METRICS,
  type DiffLineAnnotation,
  FileDiff,
  type FileDiffMetadata,
  type FileDiffOptions,
  getLineAnnotationName,
  parsePatchFiles,
  VirtualizedFileDiff,
} from "@pierre/diffs";
import type { CommentThread, ThreadMessage } from "@revv/shared";
import { buildGitPatchHeader, PIERRE_THEME, PR_DIFF_RENDER_OPTIONS } from "@revv/shared";
import { onDestroy, onMount, untrack } from "svelte";
import { getHunkScanForFile } from "$lib/hunk-scan/store.svelte";
import { AnnotationMounts } from "$lib/pierre/annotation-mount";
import {
  type DiffLineRange,
  diffRowCount,
  diffRowRange,
  rowIndexAt,
  rowIndexForNewLine,
} from "$lib/pierre/diff-rows";
import { createDiffsHost } from "$lib/pierre/mount";
import { workerManager } from "$lib/pierre/worker-pool";
import type { ReviewFile } from "$lib/stores/diff-files.svelte";
import { getLoadedHeadSha } from "$lib/stores/diff-files.svelte";
import { setDiffMode } from "$lib/stores/diff-prefs.svelte";
import {
  getActivePanel,
  getAnchorLineIndex,
  getCursorLineIndex,
  isInLineCursorMode,
  setTotalLineCount,
} from "$lib/stores/focus-mode.svelte";
import { clearPendingDiffJump, getPendingDiffJump } from "$lib/stores/review-nav.svelte";
import { phosphorMarkup } from "$lib/utils/phosphor-markup";
import { renderThreadAnnotation } from "./annotation-renderers";
import {
  type CommentRowsTrigger,
  createHeaderBadge,
  createPierreVirtualizer,
  firstPassGutterCss,
  getPierreShadowRoot,
  PIERRE_BASE_CSS,
  populateDiffHeaderSlots,
  ShadowSheet,
  type ThreadMeta,
} from "./pierre-diff-adapter";
import type { ThreadAnnotations } from "./thread-annotations.svelte";

interface Props {
  /** The PR the diff belongs to, for its first pass. */
  prId: string;
  file: ReviewFile;
  mode: "unified" | "split";
  /** Soft-wrap long lines instead of scrolling. Read once at mount; the parent re-keys on change. */
  wrap: boolean;
  threads: ThreadAnnotations;
  commentTrigger: CommentRowsTrigger | null;
  scrollRoot: HTMLElement | null;
}

let { prId, file, mode, wrap, threads, commentTrigger, scrollRoot }: Props = $props();

// Pierre's header callbacks must return light-DOM elements, so the unified /
// split toggle is built by hand.
function buildViewModePill(currentMode: "unified" | "split"): HTMLElement {
  // `fill` is the active half of the pair, matching the app-wide rule that
  // weight carries state (see the IconContext in routes/+layout.svelte).
  function makeBtn(icon: "Rows" | "Columns", label: string, active: boolean): HTMLElement {
    const btn = document.createElement("div");
    btn.innerHTML = phosphorMarkup(icon, { weight: active ? "fill" : "regular" });
    btn.title = label;
    btn.setAttribute("role", "button");
    btn.setAttribute("aria-label", label);
    btn.dataset.viewBtn = active ? "active" : "";
    return btn;
  }

  const pill = document.createElement("div");
  pill.dataset.viewPill = "";
  pill.dataset.glass = "";

  const unifiedBtn = makeBtn("Rows", "Unified view", currentMode === "unified");
  const splitBtn = makeBtn("Columns", "Split view", currentMode === "split");

  unifiedBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    setDiffMode("unified");
  });
  splitBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    setDiffMode("split");
  });

  const sep = document.createElement("div");
  sep.dataset.viewSep = "";

  pill.appendChild(unifiedBtn);
  pill.appendChild(sep);
  pill.appendChild(splitBtn);
  return pill;
}

let wrapperEl: HTMLDivElement | null = null;
// Raw: a deep proxy over Pierre's instance would be both costly and wrong.
let instance = $state.raw<FileDiff<ThreadMeta> | VirtualizedFileDiff<ThreadMeta> | null>(null);
let error = $state<string | null>(null);
let initialOptions: FileDiffOptions<ThreadMeta, undefined> | null = null;
let virtualizer = $state.raw<ReturnType<typeof createPierreVirtualizer> | null>(null);
let parsedFileDiff = $state.raw<FileDiffMetadata | null>(null);
const mounts = new AnnotationMounts();
/**
 * The annotation set (and the thread data its hosts render) last handed to
 * Pierre, by reference. The reconcile effect below skips its eager first run
 * when mount already rendered these — a forced render would wipe the
 * SSR-hydrated tokens and cost a cold worker tokenization.
 */
let appliedAnnotations: DiffLineAnnotation<ThreadMeta>[] | null = null;
let appliedThreadById: Record<string, CommentThread> | null = null;
let appliedThreadMessages: Record<string, ThreadMessage[]> | null = null;

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
 * shadow DOM: Pierre's `hydrate` adopted prerendered slots that don't cover
 * the current annotation set (see the hydrate call site in onMount).
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
  const {
    diffHeaderHeight,
    spacing,
    hunkSeparatorHeight = 32,
    lineHeight,
  } = DEFAULT_VIRTUAL_FILE_METRICS;
  const separatorGap = spacing;
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

// The keyboard cursor counts rendered rows 1..N; Pierre indexes them with the
// collapsed lines between hunks counted in.
function cursorRowIndex(cursor: number): number | null {
  return parsedFileDiff ? rowIndexAt(parsedFileDiff, cursor - 1) : null;
}

function cursorRange(from: number, to: number): DiffLineRange | null {
  const fromIndex = cursorRowIndex(from);
  const toIndex = cursorRowIndex(to);
  if (!parsedFileDiff || fromIndex === null || toIndex === null) return null;
  return diffRowRange(parsedFileDiff, fromIndex, toIndex);
}

// The reference-equality guard skips the eager first run, since onMount has
// already rendered. Load-bearing: the hydrate path in onMount may leave
// `appliedAnnotations` null on purpose so this fires one corrective render;
// don't assume it is always set after mount, or comments vanish in unified view.
$effect(() => {
  if (!instance) return;
  const currentAnnotations = threads.annotations;
  const currentThreadById = threads.threadById;
  const currentThreadMessages = threads.threadMessages;
  if (
    currentAnnotations === appliedAnnotations &&
    currentThreadById === appliedThreadById &&
    currentThreadMessages === appliedThreadMessages
  )
    return;
  appliedAnnotations = currentAnnotations;
  appliedThreadById = currentThreadById;
  appliedThreadMessages = currentThreadMessages;

  // Pierre's renderAnnotations() removes a changed annotation's previous
  // wrapper itself, and the metadata objects are fresh on every change, so
  // every host is re-rendered. Do NOT clear its `annotationCache`: that empties
  // the Map without removing the wrappers from the shadow DOM, and the next
  // render appends fresh rows beside the orphans (duplicated comments).

  // Pierre's applyHeaderToDOM reuses header slot elements by reference; a
  // forced render regenerates the header, so stale slots would duplicate the
  // badges unless cleared first.
  // @ts-expect-error clearHeaderSlots is protected
  instance.clearHeaderSlots?.();

  instance.render({ lineAnnotations: currentAnnotations, forceRender: true });
  mounts.pruneDetached();
});

// Their own stylesheet, so a cursor move never re-parses them and a scan event
// never touches the cursor CSS.
const firstPassCss = $derived(
  firstPassGutterCss(parsedFileDiff, getHunkScanForFile(prId, getLoadedHeadSha(prId), file.path)),
);
const firstPassSheet = new ShadowSheet();

$effect(() => {
  if (!instance) return;
  firstPassSheet.apply(getShadowRoot(), firstPassCss);
});

/**
 * Pierre's `setOptions` only stores `unsafeCSS`; it injects it on the next
 * render. Inject now so a highlight doesn't wait for a scroll to appear.
 */
function applyUnsafeCss(css: string): void {
  if (!instance || !initialOptions) return;
  instance.setOptions({ ...initialOptions, unsafeCSS: css });
  // @ts-expect-error injectUnsafeCSS is protected
  instance.injectUnsafeCSS?.();
}

$effect(() => {
  if (!instance || !initialOptions) return;
  const panel = getActivePanel();
  const row = cursorRowIndex(getCursorLineIndex());

  if (panel === "diff-line" && row !== null) {
    applyUnsafeCss(
      `${PIERRE_BASE_CSS} [data-line-index^="${row},"] { background-color: var(--color-tree-active-bg) !important; outline: 1px solid color-mix(in srgb, var(--color-accent) 25%, transparent); outline-offset: -1px; }`,
    );
  } else if (panel !== "diff-visual") {
    // Visual mode highlights through setSelectedLines instead.
    applyUnsafeCss(PIERRE_BASE_CSS);
  }
});

$effect(() => {
  if (!isInLineCursorMode()) return;
  const row = cursorRowIndex(getCursorLineIndex());
  if (row === null) return;

  requestAnimationFrame(() => {
    scrollLineIntoView(row);
  });
});

$effect(() => {
  const jump = getPendingDiffJump();
  if (!jump || jump.filePath !== file.path || !instance || !parsedFileDiff) return;

  const row = rowIndexForNewLine(parsedFileDiff, jump.lineNumber);
  if (row === null) return;

  setTimeout(() => {
    requestAnimationFrame(() => {
      scrollLineIntoView(row, clearPendingDiffJump);
    });
  }, 50);
});

$effect(() => {
  if (!instance) return;

  if (getActivePanel() === "diff-visual") {
    const anchor = getAnchorLineIndex();
    if (anchor === null) return;
    const range = cursorRange(anchor, getCursorLineIndex());
    instance.setSelectedLines(
      range && {
        start: range.startLine,
        end: range.endLine,
        side: range.side,
        endSide: range.side,
      },
    );
    applyUnsafeCss(PIERRE_BASE_CSS);
  } else {
    instance.setSelectedLines(null);
  }
});

$effect(() => {
  const trigger = commentTrigger;
  if (!trigger || !parsedFileDiff) return;
  untrack(() => {
    if (!threads.claimTrigger(trigger.seq)) return;
    const range = cursorRange(trigger.fromRow, trigger.toRow);
    if (range) threads.openInput(range);
  });
});

onMount(() => {
  if (!wrapperEl) return;

  try {
    const options: FileDiffOptions<ThreadMeta, undefined> = {
      ...PR_DIFF_RENDER_OPTIONS,
      diffStyle: mode,
      overflow: wrap ? "wrap" : "scroll",
      theme: PIERRE_THEME,
      enableGutterUtility: true,
      enableLineSelection: true,
      unsafeCSS: PIERRE_BASE_CSS,

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

      renderHeaderMetadata() {
        return buildViewModePill(mode);
      },

      onLineClick(props) {
        threads.toggleInputAt(props.annotationSide, props.lineNumber);
      },

      renderAnnotation(annotation) {
        const meta = annotation.metadata;
        if (!meta) return undefined;
        return renderThreadAnnotation(mounts, threads, meta);
      },

      onPostRender(node) {
        // Pierre hardcodes `pre.tabIndex = 0` (see setWrapperNodeProps)
        // with no opt-out. We use focus-mode for line-level keyboard
        // navigation instead, so opt this pre out of the tab order.
        const pre = node.shadowRoot?.querySelector("pre");
        if (pre) pre.tabIndex = -1;
      },
    };

    initialOptions = options;
    const annotations = threads.annotations;

    // Parsing GitHub's patch directly keeps its exact additions/deletions
    // counts, so Pierre's header stats match the file tree.
    const patchHeader = buildGitPatchHeader(file);
    const fullPatch = file.patch ? `${patchHeader}\n${file.patch}` : patchHeader;
    const parsed = parsePatchFiles(fullPatch)[0]?.files[0];
    if (!parsed) {
      error = "Failed to parse patch";
      return;
    }
    parsedFileDiff = parsed;

    // SSR-hydrate only when the server prerendered unified mode (it doesn't
    // know the user's mode preference) for `overflow: scroll` (so not wrap).
    // Hydrate skips the worker tokenize round-trip and paints synchronously.
    // Pierre's `hydrate` doesn't call `renderHeaderPrefix` /
    // `renderHeaderMetadata` (only `render` does), so the header slots are
    // filled by hand.
    if (file.prerenderedHtml !== undefined && mode === "unified" && !wrap) {
      instance = new FileDiff<ThreadMeta>(options, workerManager);
      const hostEl = createDiffsHost();
      wrapperEl.appendChild(hostEl);
      instance.hydrate({
        fileContainer: hostEl,
        prerenderedHTML: file.prerenderedHtml,
        fileDiff: parsed,
        lineAnnotations: annotations,
      });
      populateDiffHeaderSlots(hostEl, parsed, options);

      // The server prerenders annotation slots from a point-in-time thread
      // snapshot (`/api/prs/:id/files`); the live thread set (reloaded on SSE
      // without refetching files) can hold more, e.g. AI comments that landed
      // later. `hydrate` adopts the prerendered slots as-is, so those comments
      // would project into no slot and silently vanish. Leaving
      // appliedAnnotations null makes the reconcile $effect fire one corrective
      // render(); otherwise the no-tokenize fast paint is kept.
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
      appliedAnnotations = annotations;
    }
    appliedThreadById = threads.threadById;
    appliedThreadMessages = threads.threadMessages;

    setTotalLineCount(diffRowCount(parsed));
  } catch (e) {
    console.error("[DiffViewerInner] Render error:", e);
    error = e instanceof Error ? e.message : String(e);
  }
});

onDestroy(() => {
  mounts.clear();
  try {
    instance?.cleanUp();
    virtualizer?.cleanUp();
  } catch (e) {
    console.warn("[DiffViewerInner] Pierre cleanup failed:", e);
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

	/* The view-mode pill lives in light DOM inside diffs-container. */
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
