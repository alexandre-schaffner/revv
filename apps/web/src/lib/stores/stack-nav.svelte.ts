// ── Moving through a PR stack ───────────────────────────────────────────────
//
// What the ⌥⌘↑/↓ shortcuts, the palette and the walkthrough's stack surfaces
// share: where the open PR sits in its stack and how to move to another layer.
//
// Direction follows the stack, not the screen: "up" is toward the top layer
// (higher positions, landing later), "down" toward the base, the way the
// stack lists draw it.

import type { PrStackDetail, StackLayer } from "@revv/shared";
import { toast } from "svelte-sonner";
import { openStackLayer } from "$lib/components/stack/open-layer";
import { isOpenLayer, needsReview } from "$lib/components/stack/stack-layer-facts";
import { type NavigationDirection, setNavigationIntent } from "./navigation-intent.svelte";
import { getSelectedPr } from "./prs.svelte";
import { openStackMergeSheet } from "./stack-merge.svelte";
import { getStack, startStackReview } from "./stacks.svelte";

export interface StackView {
  readonly prId: string;
  readonly stack: PrStackDetail;
  /** The open PR's layer. */
  readonly here: StackLayer;
}

/** The open PR's place in its stack, once the stack is loaded; null when unstacked. */
export function getStackView(): StackView | null {
  const pr = getSelectedPr();
  if (!pr?.stack) return null;
  const stack = getStack(pr.id);
  if (!stack || stack.layers.length < 2) return null;
  const here =
    stack.layers.find((l) => l.prId === pr.id) ??
    stack.layers.find((l) => l.number === pr.externalId);
  return here ? { prId: pr.id, stack, here } : null;
}

/** An open layer without a review of its current head (and none on the way). */
function layerNeedsReview(layer: StackLayer): boolean {
  return isOpenLayer(layer) && needsReview(layer);
}

// ── Moving ──────────────────────────────────────────────────────────────────

/** Open another layer of the open PR's stack, the page sliding the way the stack goes. */
export function openLayer(layer: StackLayer): void {
  const view = getStackView();
  if (!view || layer.position === view.here.position) return;
  setNavigationIntent(layer.position > view.here.position ? "up" : "down");
  openStackLayer(view.prId, layer);
}

/** Move one layer up or down; nothing at either end. */
export function moveInStack(direction: NavigationDirection): void {
  const view = getStackView();
  if (!view) return;
  const offset = direction === "up" ? 1 : -1;
  const target = view.stack.layers.find((l) => l.position === view.here.position + offset);
  if (target) openLayer(target);
}

/**
 * The nearest layer still owed a review: the ones above first (reviewing goes
 * bottom-up), then from the base. Null when every open layer is covered.
 */
function nextUnreviewedLayer(view: StackView): StackLayer | null {
  const candidates = view.stack.layers.filter(
    (l) => l.position !== view.here.position && layerNeedsReview(l),
  );
  return (
    candidates.find((l) => l.position > view.here.position) ??
    candidates.find((l) => l.position < view.here.position) ??
    null
  );
}

export function openNextUnreviewedLayer(): void {
  const view = getStackView();
  if (!view) return;
  const next = nextUnreviewedLayer(view);
  if (next) openLayer(next);
  else toast("Every open layer has a current review.");
}

// ── Whole-stack actions ─────────────────────────────────────────────────────

/** Layers "Review stack" would queue: open, tracked, and owed a review. */
export function remainingLayers(stack: PrStackDetail): StackLayer[] {
  return stack.layers.filter((l) => l.prId !== null && layerNeedsReview(l));
}

function numbers(list: readonly number[]): string {
  return list.map((n) => `#${n}`).join(", ");
}

export async function reviewRemainingLayers(): Promise<void> {
  const view = getStackView();
  if (!view) return;
  const started = await startStackReview(view.prId, "remaining");
  if (!started) {
    toast.error("Couldn't start the stack review.");
    return;
  }
  const { queued, untracked } = started;
  const skipped =
    untracked.length > 0
      ? `${numbers(untracked)} ${untracked.length === 1 ? "isn't" : "aren't"} tracked in Revv.`
      : null;
  if (queued.length === 0) {
    toast("Nothing left to review in this stack.", skipped ? { description: skipped } : {});
    return;
  }
  const title =
    queued.length === 1 ? `Reviewing ${numbers(queued)}` : `Reviewing ${queued.length} layers`;
  const order = queued.length > 1 ? `${numbers(queued)}, bottom-up.` : null;
  const description = [order, skipped].filter(Boolean).join(" ");
  toast.success(title, description ? { description } : {});
}

export function mergeOpenStack(): void {
  const view = getStackView();
  if (view) openStackMergeSheet(view.prId);
}
