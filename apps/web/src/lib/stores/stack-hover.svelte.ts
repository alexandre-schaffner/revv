// ── The stack layer a margin chip points at ────────────────────────────────
//
// One hover, two places on the page: a layer chip in a walkthrough margin
// note names a layer, and the thumb index beside the title lights that
// layer's notch while the pointer (or focus) is on the chip.

let hovered = $state<number | null>(null);

/** The PR number of the layer a chip is pointing at, or null. */
export function getHoveredLayer(): number | null {
  return hovered;
}

export function setHoveredLayer(number: number | null): void {
  hovered = number;
}
