import { isOpenLayer, type PrStackDetail, type StackLayer } from "@revv/shared";
import { toast } from "svelte-sonner";
import { openStackLayer } from "$lib/stacks/open-layer";
import { needsReview } from "$lib/stacks/stack-layer-facts";
import type { NavigationDirection } from "./navigation-intent.svelte";
import { getSelectedPr } from "./prs.svelte";
import { openStackMergeSheet } from "./stack-merge.svelte";
import { getLayer, getNeighbour, getStack, startStackReview } from "./stacks.svelte";

export interface StackView {
  readonly prId: string;
  readonly stack: PrStackDetail;
  readonly here: StackLayer;
}

export function getStackView(): StackView | null {
  const pr = getSelectedPr();
  if (!pr?.stack) return null;
  const stack = getStack(pr.id);
  if (!stack || stack.layers.length < 2) return null;
  const here = getLayer(pr.id);
  return here ? { prId: pr.id, stack, here } : null;
}

function layerNeedsReview(layer: StackLayer): boolean {
  return isOpenLayer(layer) && needsReview(layer);
}

export function openLayer(layer: StackLayer): void {
  const view = getStackView();
  if (!view || layer.position === view.here.position) return;
  openStackLayer(view.prId, layer);
}

export function moveInStack(direction: NavigationDirection): void {
  const view = getStackView();
  if (!view) return;
  const target = getNeighbour(view.prId, direction);
  if (target) openLayer(target);
}

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
