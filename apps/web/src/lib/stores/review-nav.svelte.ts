// Navigation on the review page: moving between its tabs to a target, and
// scrolling a pane to an anchor. Each pane registers its scroll container
// with `use:scrollPane`, which also keeps the pane's scroll position per PR.

import { tick } from "svelte";
import type { Action } from "svelte/action";
import { pulseHighlight } from "$lib/motion";
import {
  getPrScrollPosition,
  getReviewFiles,
  setActiveFilePath,
  setActiveTab,
  setPrScrollPosition,
} from "./review.svelte";

export type ReviewPane = "walkthrough" | "conversation" | "diff";

let roots = $state.raw<Partial<Record<ReviewPane, HTMLElement>>>({});

/** The scroll container of `pane`, while that pane is on screen. */
export function getScrollRoot(pane: ReviewPane): HTMLElement | null {
  return roots[pane] ?? null;
}

function setRoot(node: HTMLElement, pane: ReviewPane | null): void {
  const next: Partial<Record<ReviewPane, HTMLElement>> = {};
  for (const [key, el] of Object.entries(roots) as [ReviewPane, HTMLElement][]) {
    if (el !== node) next[key] = el;
  }
  if (pane !== null) next[pane] = node;
  roots = next;
}

interface ScrollPaneParams {
  prId: string;
  /** The pane this element shows; null while it is hidden. */
  pane: ReviewPane | null;
}

/**
 * Marks the element as the scroll container of `pane` and keeps that pane's
 * scroll offset per PR: restored when the pane (or the PR) comes on screen,
 * saved on every scroll.
 */
export const scrollPane: Action<HTMLElement, ScrollPaneParams> = (node, params) => {
  let current = params;
  let restoredFor: string | null = null;
  // Restoring emits a scroll event, which would otherwise save whatever
  // offset the browser clamped the restore to before the content laid out.
  let suppressNextScroll = false;

  const restore = (): void => {
    const { prId, pane } = current;
    setRoot(node, pane);
    if (pane === null) {
      // A `display: none` element doesn't reliably keep its offset.
      restoredFor = null;
      return;
    }
    const stamp = `${prId}:${pane}`;
    if (stamp === restoredFor) return;
    restoredFor = stamp;
    suppressNextScroll = true;
    node.scrollTop = getPrScrollPosition(prId, pane);
  };

  const onScroll = (): void => {
    if (suppressNextScroll) {
      suppressNextScroll = false;
      return;
    }
    if (current.pane !== null) setPrScrollPosition(current.prId, current.pane, node.scrollTop);
  };

  setRoot(node, current.pane);
  // The pane's content renders in the same flush as this element; restoring
  // before it lays out would clamp the offset.
  void tick().then(restore);
  node.addEventListener("scroll", onScroll);
  return {
    update(next: ScrollPaneParams) {
      current = next;
      restore();
    },
    destroy() {
      node.removeEventListener("scroll", onScroll);
      setRoot(node, null);
    },
  };
};

const ANCHOR_WAIT_FRAMES = 60;

/**
 * Scroll `pane` so the element with `id` sits `offset` px below the pane's
 * top, waiting (a frame at least, about a second at most) for the pane to show
 * and the element to lay out. `highlight` flashes the element's outline.
 */
export function scrollToAnchor(
  pane: ReviewPane,
  id: string,
  { offset = 16, highlight = false }: { offset?: number; highlight?: boolean } = {},
): void {
  let frames = 0;
  const attempt = (): void => {
    const root = roots[pane];
    const el = document.getElementById(id);
    if (!root || !el || el.getClientRects().length === 0) {
      if (++frames < ANCHOR_WAIT_FRAMES) requestAnimationFrame(attempt);
      return;
    }
    const top =
      el.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop - offset;
    root.scrollTo({ top, behavior: "smooth" });
    if (highlight) pulseHighlight(el);
  };
  requestAnimationFrame(attempt);
}

/** Open the walkthrough on one of its blocks. */
export function jumpToWalkthroughBlock(blockId: string): void {
  setActiveTab("walkthrough");
  scrollToAnchor("walkthrough", `step-${blockId}`, { highlight: true });
}

// The diff pane resolves a line jump itself, once Pierre has rendered the file.
interface DiffLineJump {
  filePath: string;
  lineNumber: number;
}

let pendingDiffJump = $state<DiffLineJump | null>(null);

export function getPendingDiffJump(): DiffLineJump | null {
  return pendingDiffJump;
}

export function clearPendingDiffJump(): void {
  pendingDiffJump = null;
}

export function jumpToDiffLine(filePath: string, lineNumber: number): void {
  pendingDiffJump = { filePath, lineNumber };
  setActiveFilePath(filePath);
  setActiveTab("diff");
}

/**
 * Open a changed file in the diff tab, optionally at a line. No-ops when the
 * path isn't part of the loaded review (a stale render can lag a pull);
 * matches `oldPath` too, so a renamed file still resolves.
 */
export function openFileInDiff(filePath: string, lineNumber?: number): void {
  const match = getReviewFiles().find((f) => f.path === filePath || f.oldPath === filePath);
  if (!match) return;
  if (typeof lineNumber === "number") {
    jumpToDiffLine(match.path, lineNumber);
    return;
  }
  setActiveFilePath(match.path);
  setActiveTab("diff");
}

/** Back to the top of the diff, once the newly picked file has rendered. */
export function scrollDiffToTop(): void {
  void tick().then(() => {
    const root = roots.diff;
    if (root) root.scrollTop = 0;
  });
}

export function reset(): void {
  pendingDiffJump = null;
}
