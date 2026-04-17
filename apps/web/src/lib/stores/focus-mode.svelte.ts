// ── Focus-mode store ────────────────────────────────────────
//
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

export type FocusPanel =
	| 'sidebar'
	| 'diff-scroll'
	| 'diff-line'
	| 'diff-visual';

// ── Core panel state ────────────────────────────────────────

let activePanel = $state<FocusPanel>('sidebar');

// ── Cursor / selection state ────────────────────────────────
// Used by diff-line and diff-visual modes.
// cursorLineIndex is 1-based and maps to [data-line-index] rendered row indices
// (not [data-line] which is the actual file line number — those are distinct library attributes).

/** The currently active/focused line. */
let cursorLineIndex = $state<number>(1);

/**
 * Which column the cursor is on. `null` in unified mode (no column
 * distinction) or when not yet set. Mirrors the library's optional
 * `side?` field in SelectedLineRange — never pass null directly to
 * the library; omit the property instead.
 */
let cursorSide = $state<'additions' | 'deletions' | null>(null);

/** Visual-mode anchor line (start of selection). null outside visual mode. */
let anchorLineIndex = $state<number | null>(null);
let anchorSide = $state<'additions' | 'deletions' | null>(null);

/**
 * Total rendered line count. Set by DiffViewerInner after each render.
 * Used to clamp cursor movement.
 */
let totalLineCount = $state<number>(0);

// ── Getters ─────────────────────────────────────────────────

export function getActivePanel(): FocusPanel {
	return activePanel;
}

export function getCursorLineIndex(): number {
	return cursorLineIndex;
}

export function getCursorSide(): 'additions' | 'deletions' | null {
	return cursorSide;
}

export function getAnchorLineIndex(): number | null {
	return anchorLineIndex;
}

export function getAnchorSide(): 'additions' | 'deletions' | null {
	return anchorSide;
}

export function getTotalLineCount(): number {
	return totalLineCount;
}

// ── State setters ───────────────────────────────────────────

export function setTotalLineCount(n: number): void {
	totalLineCount = n;
}

// ── Mode transition helpers ─────────────────────────────────

/** Check if we're in any diff mode (not sidebar). */
export function isInDiffMode(): boolean {
	return activePanel !== 'sidebar';
}

/** Check if we're in a mode that tracks a line cursor. */
export function isInLineCursorMode(): boolean {
	return activePanel === 'diff-line' || activePanel === 'diff-visual';
}

/**
 * Enter diff scroll mode (Space from sidebar).
 * Pixel-based scrolling — no line cursor.
 */
export function enterScrollMode(): void {
	resetCursorState();
	activePanel = 'diff-scroll';

	requestAnimationFrame(() => {
		const diffScroll = document.querySelector<HTMLElement>('.diff-scroll');
		if (diffScroll) {
			if (!diffScroll.getAttribute('tabindex')) {
				diffScroll.setAttribute('tabindex', '-1');
			}
			diffScroll.focus({ preventScroll: true });
		}
	});
}

/**
 * Enter diff-line mode.
 * @param totalLines — total rendered line count, queried by DiffViewerInner
 */
export function enterLineMode(totalLines: number): void {
	totalLineCount = totalLines;
	// Preserve cursor position if already in a diff mode, else reset to line 1
	if (!isInLineCursorMode()) {
		cursorLineIndex = 1;
		cursorSide = null;
	}
	anchorLineIndex = null;
	anchorSide = null;
	activePanel = 'diff-line';
}

/**
 * Enter diff-visual mode.
 * Anchors selection at the current cursor line.
 */
export function enterVisualMode(): void {
	anchorLineIndex = cursorLineIndex;
	anchorSide = cursorSide;
	activePanel = 'diff-visual';
}

/**
 * Exit visual mode back to diff-line.
 * Clears selection anchor.
 */
export function exitVisualMode(): void {
	anchorLineIndex = null;
	anchorSide = null;
	activePanel = 'diff-line';
}

/**
 * Return to sidebar navigation mode.
 */
export function enterSidebarMode(): void {
	resetCursorState();
	activePanel = 'sidebar';
}

// ── Cursor movement (pure state, no DOM) ───────────────────

/**
 * Move the cursor by `delta` lines (positive = down, negative = up).
 * Clamps to [1, totalLineCount].
 */
export function moveCursor(delta: number): void {
	if (totalLineCount === 0) return;
	cursorLineIndex = Math.max(1, Math.min(totalLineCount, cursorLineIndex + delta));
}

/**
 * Jump cursor to a named position.
 * half-up/half-down move by 50% of total lines.
 */
export function jumpCursor(target: 'top' | 'bottom' | 'half-up' | 'half-down'): void {
	if (totalLineCount === 0) return;
	switch (target) {
		case 'top':
			cursorLineIndex = 1;
			break;
		case 'bottom':
			cursorLineIndex = totalLineCount;
			break;
		case 'half-up':
			cursorLineIndex = Math.max(1, cursorLineIndex - Math.floor(totalLineCount / 2));
			break;
		case 'half-down':
			cursorLineIndex = Math.min(totalLineCount, cursorLineIndex + Math.floor(totalLineCount / 2));
			break;
	}
}

// ── Internal helpers ────────────────────────────────────────

/**
 * Reset cursor/selection state to defaults.
 * Called when returning to sidebar or entering scroll mode.
 */
function resetCursorState(): void {
	cursorLineIndex = 1;
	cursorSide = null;
	anchorLineIndex = null;
	anchorSide = null;
}
