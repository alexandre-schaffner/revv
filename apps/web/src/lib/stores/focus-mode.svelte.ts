// Tracks which panel currently owns keyboard focus and the
// cursor/selection state for Vim-like diff navigation.
//
// Modes:
//   'sidebar'      — Vim-like sidebar/file-tree navigation (default)
//   'diff-scroll'  — diff viewport pixel-scrolling (j/k/d/u/G/gg)
//   'diff-line'    — diff with highlighted active line, j/k moves line-by-line
//   'diff-visual'  — line-range selection anchored at a line, j/k extends range
//
// Transitions:
//   sidebar        → diff-scroll  :  Space
//   sidebar        → diff-line    :  v
//   diff-scroll    → diff-line    :  v
//   diff-scroll    → sidebar      :  Escape / Space / h / t
//   diff-line      → diff-visual  :  v
//   diff-line      → sidebar      :  Escape / Space / h / t
//   diff-visual    → diff-line    :  v (toggle off)
//   diff-visual    → sidebar      :  Escape / Space / h / t

export type FocusPanel = "sidebar" | "diff-scroll" | "diff-line" | "diff-visual";

let activePanel = $state<FocusPanel>("sidebar");

// The cursor counts the diff's rows 1..N; `lib/pierre/diff-rows.ts` maps a
// row to its file line and side.
let cursorLineIndex = $state<number>(1);

/** Visual-mode anchor line (start of selection). null outside visual mode. */
let anchorLineIndex = $state<number | null>(null);

let totalLineCount = $state<number>(0);

export function getActivePanel(): FocusPanel {
  return activePanel;
}

export function getCursorLineIndex(): number {
  return cursorLineIndex;
}

export function getAnchorLineIndex(): number | null {
  return anchorLineIndex;
}

export function getTotalLineCount(): number {
  return totalLineCount;
}

export function setTotalLineCount(n: number): void {
  totalLineCount = n;
}

export function isInDiffMode(): boolean {
  return activePanel !== "sidebar";
}

export function isInLineCursorMode(): boolean {
  return activePanel === "diff-line" || activePanel === "diff-visual";
}

export function enterScrollMode(): void {
  resetCursorState();
  activePanel = "diff-scroll";

  requestAnimationFrame(() => {
    const diffScroll = document.querySelector<HTMLElement>(".diff-scroll");
    if (diffScroll) {
      if (!diffScroll.getAttribute("tabindex")) {
        diffScroll.setAttribute("tabindex", "-1");
      }
      diffScroll.focus({ preventScroll: true });
    }
  });
}

export function enterLineMode(totalLines: number): void {
  totalLineCount = totalLines;
  if (!isInLineCursorMode()) {
    cursorLineIndex = 1;
  }
  anchorLineIndex = null;
  activePanel = "diff-line";
}

export function enterVisualMode(): void {
  anchorLineIndex = cursorLineIndex;
  activePanel = "diff-visual";
}

export function exitVisualMode(): void {
  anchorLineIndex = null;
  activePanel = "diff-line";
}

export function enterSidebarMode(): void {
  resetCursorState();
  activePanel = "sidebar";
}

/** Move the cursor by `delta` lines (positive = down). */
export function moveCursor(delta: number): void {
  if (totalLineCount === 0) return;
  cursorLineIndex = Math.max(1, Math.min(totalLineCount, cursorLineIndex + delta));
}

export function jumpCursor(target: "top" | "bottom" | "half-up" | "half-down"): void {
  if (totalLineCount === 0) return;
  switch (target) {
    case "top":
      cursorLineIndex = 1;
      break;
    case "bottom":
      cursorLineIndex = totalLineCount;
      break;
    case "half-up":
      cursorLineIndex = Math.max(1, cursorLineIndex - Math.floor(totalLineCount / 2));
      break;
    case "half-down":
      cursorLineIndex = Math.min(totalLineCount, cursorLineIndex + Math.floor(totalLineCount / 2));
      break;
  }
}

function resetCursorState(): void {
  cursorLineIndex = 1;
  anchorLineIndex = null;
}
