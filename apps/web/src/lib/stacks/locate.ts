// ── Where a PR sits in its stack ────────────────────────────────────────────
//
// Every stack surface (the thumb index, the handoff card, the restack banner,
// the merge bar, ⌥⌘↑/↓) finds the open PR's layer and its neighbours the same
// way, so they never disagree about which layer is "here" or "next".

import type { PrStackDetail, StackLayer } from "@revv/shared";

/**
 * The layer `prId` occupies. By Revv's id first; by PR number when the stack
 * read didn't know the id (the layer was untracked when it was read).
 */
export function layerOf(
  stack: PrStackDetail,
  prId: string,
  prNumber: number | null,
): StackLayer | null {
  return (
    stack.layers.find((l) => l.prId === prId) ??
    (prNumber === null ? undefined : stack.layers.find((l) => l.number === prNumber)) ??
    null
  );
}

/** The layer `offset` positions from `from` (+1 is up, toward the top), or null at an end. */
export function layerAt(stack: PrStackDetail, from: StackLayer, offset: number): StackLayer | null {
  return stack.layers.find((l) => l.position === from.position + offset) ?? null;
}
