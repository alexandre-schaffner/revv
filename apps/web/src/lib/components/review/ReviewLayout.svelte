<script lang="ts">
import { isImagePath } from "@revv/shared";
import { onDestroy, untrack } from "svelte";
import {
  enterLineMode,
  enterScrollMode,
  enterSidebarMode,
  enterVisualMode,
  exitVisualMode,
  getActivePanel,
  getAnchorLineIndex,
  getCursorLineIndex,
  getCursorSide,
  getTotalLineCount,
  isInDiffMode,
  jumpCursor,
  moveCursor,
} from "$lib/stores/focus-mode.svelte";
import {
  getActiveFilePath,
  getDiffScrollResetSeq,
  getPrScrollPosition,
  getRepoFile,
  getRepoFilePath,
  setActiveFilePath,
  setDiffMode,
  setPrScrollPosition,
} from "$lib/stores/review.svelte";
import { setTopbarSubtitle } from "$lib/stores/topbar.svelte";
import type { ReviewFile } from "$lib/types/review";
import DiffViewer from "./DiffViewer.svelte";
import FileIssues from "./FileIssues.svelte";
import FileViewer from "./FileViewer.svelte";
import ImageDiffViewer from "./ImageDiffViewer.svelte";

// ── Props ─────────────────────────────────────────────────────────────────

interface Props {
  prId: string;
  files: ReviewFile[];
}

let { prId, files }: Props = $props();

// ── Layout state ──────────────────────────────────────────────────────────

const activeFilePath = $derived(getActiveFilePath());
const activeFile = $derived(files.find((f) => f.path === activeFilePath) ?? null);
// Image files: GitHub returns no patch (it's a binary blob), so the diff
// renderer has nothing to render. Route those through the image viewer
// which fetches the bytes for both sides from the local clone. The check
// is path-only — true for renames where one side is an image (the other
// side's bytes will fail with 404 and surface as a per-pane error).
const activeFileIsImage = $derived(
  activeFile !== null &&
    (isImagePath(activeFile.path) ||
      (activeFile.oldPath !== undefined && isImagePath(activeFile.oldPath))),
);
// Filename for the title bar — falls back to the raw path when neither
// `activeFile` (PR-changed) nor a tree-selection has populated something.
// Used by both the diff path and the file-viewer path so they share one
// rendering pipeline for the big title at the top of the main pane.
const activeFileName = $derived.by((): string => {
  if (activeFile) return activeFile.path.split("/").pop() ?? activeFile.path;
  if (activeFilePath) return activeFilePath.split("/").pop() ?? activeFilePath;
  return "";
});

// File-viewer surface — used when the user picks a file that *isn't* in
// the PR diff, so DiffViewer has nothing to render. We mirror the path
// the loader is fetching so the viewer doesn't flash stale content while
// a new request is in flight.
const repoFile = $derived(getRepoFile());
const repoFilePath = $derived(getRepoFilePath());
const showFileViewer = $derived(
  activeFilePath !== null &&
    activeFile === null &&
    (repoFilePath === activeFilePath || repoFile.status === "loading"),
);

// ── Token hover state ────────────────────────────────────────────────────
//
// The legacy explanation feature wired sparkle-tooltip explanations to
// token hover. With the right pane now hosting the chat agent, that
// affordance was removed — see CLAUDE.md "AI chat" doctrine. Keeping the
// `fileTitleSectionEl` ref because other parts of this component bind to it.
let fileTitleSectionEl = $state<HTMLElement | null>(null);

// ── Comment trigger ──────────────────────────────────────────────────────

/**
 * Passed to DiffViewer to trigger opening a comment input.
 * Use `seq: Date.now()` to ensure reactivity even for repeated requests.
 */
let pendingCommentTrigger = $state<{
  startLine: number;
  endLine: number;
  side: "additions" | "deletions";
  seq: number;
} | null>(null);

function openComment(startLine: number, endLine: number, side: "additions" | "deletions") {
  pendingCommentTrigger = { startLine, endLine, side, seq: Date.now() };
}

// ── Topbar subtitle (show full path when file title scrolls out) ─────────
let fileTitleObserver: IntersectionObserver | null = null;

function setupFileTitleObserver() {
  if (fileTitleObserver) {
    fileTitleObserver.disconnect();
    fileTitleObserver = null;
  }
  if (!fileTitleSectionEl) {
    setTopbarSubtitle(null);
    return;
  }
  fileTitleObserver = new IntersectionObserver(
    ([entry]) => {
      setTopbarSubtitle(entry?.isIntersecting ? null : activeFilePath || null);
    },
    { threshold: 0 },
  );
  fileTitleObserver.observe(fileTitleSectionEl);
}

$effect(() => {
  setupFileTitleObserver();
  return () => {
    if (fileTitleObserver) {
      fileTitleObserver.disconnect();
      fileTitleObserver = null;
    }
    setTopbarSubtitle(null);
  };
});

// Keep subtitle in sync when file changes while title is scrolled out of view
$effect(() => {
  activeFilePath; // track
  if (fileTitleObserver) setupFileTitleObserver();
});

// ── Keyboard navigation ──────────────────────────────────────────────────

/** Scroll amount per j/k press (in pixels). */
const SCROLL_STEP = 80;

/** Encapsulates the pendingG / gTimer state for the gg two-key chord. */
class PendingGState {
  flag = false;
  timer: ReturnType<typeof setTimeout> | undefined;

  arm(onExpire?: () => void) {
    this.flag = true;
    this.timer = setTimeout(() => {
      this.flag = false;
      onExpire?.();
    }, 300);
  }

  disarm() {
    this.flag = false;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  reset() {
    this.disarm();
  }

  destroy() {
    this.disarm();
  }
}

const pendingG = new PendingGState();

onDestroy(() => {
  pendingG.destroy();
  if (fileTitleObserver) fileTitleObserver.disconnect();
  setTopbarSubtitle(null);
});

// ── Diff-pane scroll persistence ─────────────────────────────────────────
//
// ReviewLayout is mounted only while the Diff tab is active (see
// +page.svelte's `{#if activeTab === 'diff'}` gate), so we save/restore
// against the per-PR `prViewStates` map. Save happens continuously via
// `onscroll`; restore happens once on mount. A latch suppresses the
// scroll event emitted by setting scrollTop during the restore so it
// can't clobber the freshly-restored value.
let diffScrollEl = $state<HTMLElement | null>(null);
let suppressNextDiffScroll = false;

function getDiffScroll(): HTMLElement | null {
  return diffScrollEl ?? document.querySelector<HTMLElement>(".diff-scroll");
}

function handleDiffScroll(): void {
  if (suppressNextDiffScroll) {
    suppressNextDiffScroll = false;
    return;
  }
  if (!diffScrollEl) return;
  setPrScrollPosition(prId, "diff", diffScrollEl.scrollTop);
}

$effect(() => {
  if (!diffScrollEl) return;
  const saved = getPrScrollPosition(prId, "diff");
  suppressNextDiffScroll = true;
  diffScrollEl.scrollTop = saved;
});

// Scroll to top whenever the user explicitly selects a file from the sidebar
// (even if it's the same file — common in 1-file PRs).
$effect(() => {
  getDiffScrollResetSeq(); // track
  untrack(() => {
    if (!diffScrollEl) return;
    suppressNextDiffScroll = true;
    diffScrollEl.scrollTop = 0;
  });
});

function navigateFile(direction: 1 | -1) {
  const currentIdx = files.findIndex((f) => f.path === activeFilePath);
  const nextIdx = currentIdx + direction;
  if (nextIdx >= 0 && nextIdx < files.length) {
    // biome-ignore lint/style/noNonNullAssertion: bounds checked above
    setActiveFilePath(files[nextIdx]!.path);
  }
}

// ── Command-map keyboard dispatch ────────────────────────────────────────
//
// Two-level map: panel → key → handler. The pendingG state machine for the
// `gg` chord is encapsulated in PendingGState above.

function handleGlobalKeydown(e: KeyboardEvent) {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

  const panel = getActivePanel();

  // ── Global bindings (all panels) ──────────────────────────────────────
  if (e.key === " ") {
    e.preventDefault();
    if (isInDiffMode()) {
      enterSidebarMode();
    } else {
      enterScrollMode();
    }
    return;
  }

  if ((e.key === "h" || e.key === "t") && panel !== "sidebar") {
    e.preventDefault();
    enterSidebarMode();
    return;
  }

  // ── Panel-specific bindings ───────────────────────────────────────────
  const handled = dispatchKey(panel, e.key, e);
  if (handled) return;

  // ── Fallback: sidebar bindings (n/p file navigation) ──────────────────
  if (e.key === "n") {
    e.preventDefault();
    navigateFile(1);
  } else if (e.key === "p") {
    e.preventDefault();
    navigateFile(-1);
  }
}

type KeyHandler = (e: KeyboardEvent) => boolean;

const DIFF_VISUAL_KEYS: Record<string, KeyHandler> = {
  Escape: (e) => {
    e.preventDefault();
    enterSidebarMode();
    return true;
  },
  v: (e) => {
    e.preventDefault();
    exitVisualMode();
    return true;
  },
  j: (e) => {
    e.preventDefault();
    moveCursor(1);
    return true;
  },
  ArrowDown: (e) => {
    e.preventDefault();
    moveCursor(1);
    return true;
  },
  k: (e) => {
    e.preventDefault();
    moveCursor(-1);
    return true;
  },
  ArrowUp: (e) => {
    e.preventDefault();
    moveCursor(-1);
    return true;
  },
  c: (e) => {
    e.preventDefault();
    const cursor = getCursorLineIndex();
    const anchor = getAnchorLineIndex() ?? cursor;
    const side = getCursorSide() ?? "additions";
    openComment(Math.min(anchor, cursor), Math.max(anchor, cursor), side);
    return true;
  },
};

const DIFF_LINE_KEYS: Record<string, KeyHandler> = {
  Escape: (e) => {
    e.preventDefault();
    enterSidebarMode();
    return true;
  },
  v: (e) => {
    e.preventDefault();
    enterVisualMode();
    return true;
  },
  j: (e) => {
    e.preventDefault();
    moveCursor(1);
    return true;
  },
  ArrowDown: (e) => {
    e.preventDefault();
    moveCursor(1);
    return true;
  },
  k: (e) => {
    e.preventDefault();
    moveCursor(-1);
    return true;
  },
  ArrowUp: (e) => {
    e.preventDefault();
    moveCursor(-1);
    return true;
  },
  d: (e) => {
    e.preventDefault();
    jumpCursor("half-down");
    return true;
  },
  u: (e) => {
    e.preventDefault();
    jumpCursor("half-up");
    return true;
  },
  G: (e) => {
    e.preventDefault();
    pendingG.disarm();
    jumpCursor("bottom");
    return true;
  },
  c: (e) => {
    e.preventDefault();
    const lineIdx = getCursorLineIndex();
    const side = getCursorSide() ?? "additions";
    openComment(lineIdx, lineIdx, side);
    return true;
  },
};

const DIFF_SCROLL_KEYS: Record<string, KeyHandler> = {
  Escape: (e) => {
    e.preventDefault();
    enterSidebarMode();
    return true;
  },
  v: (e) => {
    e.preventDefault();
    enterLineMode(getTotalLineCount());
    return true;
  },
  j: (e) => {
    e.preventDefault();
    getDiffScroll()?.scrollBy({ top: SCROLL_STEP, behavior: "instant" });
    return true;
  },
  ArrowDown: (e) => {
    e.preventDefault();
    getDiffScroll()?.scrollBy({ top: SCROLL_STEP, behavior: "instant" });
    return true;
  },
  k: (e) => {
    e.preventDefault();
    getDiffScroll()?.scrollBy({ top: -SCROLL_STEP, behavior: "instant" });
    return true;
  },
  ArrowUp: (e) => {
    e.preventDefault();
    getDiffScroll()?.scrollBy({ top: -SCROLL_STEP, behavior: "instant" });
    return true;
  },
  d: (e) => {
    e.preventDefault();
    const el = getDiffScroll();
    if (el) el.scrollBy({ top: el.clientHeight / 2, behavior: "instant" });
    return true;
  },
  u: (e) => {
    e.preventDefault();
    const el = getDiffScroll();
    if (el) el.scrollBy({ top: -el.clientHeight / 2, behavior: "instant" });
    return true;
  },
  G: (e) => {
    e.preventDefault();
    pendingG.disarm();
    const el = getDiffScroll();
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "instant" });
    return true;
  },
};

const PANEL_KEY_MAP: Record<string, Record<string, KeyHandler>> = {
  "diff-visual": DIFF_VISUAL_KEYS,
  "diff-line": DIFF_LINE_KEYS,
  "diff-scroll": DIFF_SCROLL_KEYS,
};

function dispatchKey(panel: string, key: string, e: KeyboardEvent): boolean {
  const keyMap = PANEL_KEY_MAP[panel];
  if (!keyMap) return false;

  // Handle the gg two-key chord for diff-line and diff-scroll panels
  if (panel === "diff-line" || panel === "diff-scroll") {
    if (key === "g" && !e.shiftKey) {
      e.preventDefault();
      if (pendingG.flag) {
        pendingG.disarm();
        if (panel === "diff-line") {
          jumpCursor("top");
        } else {
          const el = getDiffScroll();
          if (el) el.scrollTo({ top: 0, behavior: "instant" });
        }
        return true;
      }
      pendingG.arm();
      return true;
    }
    // Any other key cancels pendingG
    if (pendingG.flag) pendingG.reset();
  }

  const handler = keyMap[key];
  if (handler) return handler(e);
  return false;
}

// ── Mode indicator derived state ─────────────────────────────────────────
const panel = $derived(getActivePanel());
</script>

<svelte:window onkeydown={handleGlobalKeydown} />

<div class="relative flex h-full flex-col overflow-hidden bg-diff-bg">
	<!-- @pierre/diffs renderer -->
	<div
		class="diff-scroll min-h-0 flex-1 overflow-y-auto overflow-x-hidden outline-none"
		class:mode-scroll={panel === 'diff-scroll'}
		class:mode-line={panel === 'diff-line'}
		class:mode-visual={panel === 'diff-visual'}
		tabindex="-1"
		role="presentation"
		bind:this={diffScrollEl}
		onscroll={handleDiffScroll}
	>
		{#if activeFile}
			<div class="file-title-section" bind:this={fileTitleSectionEl}>
				<h1 class="file-title">{activeFileName}</h1>
			</div>
			<FileIssues filePath={activeFile.path} />
			{#if activeFileIsImage}
				<ImageDiffViewer {prId} file={activeFile} />
			{:else}
				<DiffViewer
					file={activeFile}
					onModeChange={(m) => setDiffMode(m)}
					commentTrigger={pendingCommentTrigger}
				/>
			{/if}
		{:else if showFileViewer && activeFilePath}
			<!-- Title rendered by the layout (same as the diff path) so the
			     file viewer fills the pane edge-to-edge — no inner padding,
			     full-width gutter, identical font / sizing to the diff. -->
			<div class="file-title-section" bind:this={fileTitleSectionEl}>
				<h1 class="file-title">{activeFileName}</h1>
			</div>
			<FileViewer
				path={activeFilePath}
				content={repoFile.status === "ok" && repoFile.data.status === "ready" ? repoFile.data.content : ""}
				isBinary={repoFile.status === "ok" && repoFile.data.status === "binary"}
				size={repoFile.status === "ok" ? ("size" in repoFile.data ? repoFile.data.size : 0) : 0}
				status={repoFile.status === "ok" ? repoFile.data.status : repoFile.status}
				errorMessage={repoFile.status === "error" ? repoFile.error : null}
			/>
		{:else}
			<DiffViewer
				file={null}
				onModeChange={(m) => setDiffMode(m)}
				commentTrigger={pendingCommentTrigger}
			/>
		{/if}
	</div>

</div>

<style>
	.file-title-section {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 76px 32px 16px;
		flex-shrink: 0;
	}

	.file-title {
		font-size: 32px;
		font-weight: 700;
		color: var(--color-text-primary);
		line-height: 1.2;
		letter-spacing: -0.02em;
		margin: 0;
		font-family: var(--font-mono, monospace);
		word-break: break-all;
	}
</style>

