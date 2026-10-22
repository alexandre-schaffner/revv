import type { PrStackDetail, StackLayer } from "@revv/shared";
import type { NavigationDirection } from "$lib/stores/navigation-intent.svelte";

const POSITION_STEP: Record<NavigationDirection, number> = { up: 1, down: -1 };

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

export function neighbourOf(
  stack: PrStackDetail,
  from: StackLayer,
  direction: NavigationDirection,
): StackLayer | null {
  const position = from.position + POSITION_STEP[direction];
  return stack.layers.find((l) => l.position === position) ?? null;
}
