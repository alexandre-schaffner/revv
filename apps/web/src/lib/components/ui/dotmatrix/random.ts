// Same turn id, same variant. The walkthrough's chapter spinners (`ripple`,
// `diagonal`, `collapse`, `prism-bloom`, and `square-14`, which shares
// `prism-bloom`'s config) stay out of the chat pool so the chat doesn't look
// like the walkthrough.

import { hash32 } from "$lib/utils/hash";
import { DOTMATRIX_VARIANT_KEYS, type DotmatrixVariant } from "./variants";

const WALKTHROUGH_VARIANTS = new Set<DotmatrixVariant>([
  "ripple",
  "diagonal",
  "collapse",
  "prism-bloom",
  "square-14", // identical to prism-bloom; exclude to avoid duplicate look
]);

const CHAT_VARIANT_POOL: readonly DotmatrixVariant[] = DOTMATRIX_VARIANT_KEYS.filter(
  (v) => !WALKTHROUGH_VARIANTS.has(v),
);

export function squareVariantForId(id: string): DotmatrixVariant {
  const idx = hash32(id) % CHAT_VARIANT_POOL.length;
  const variant = CHAT_VARIANT_POOL[idx];
  if (!variant) throw new Error(`Invalid variant index: ${idx}`);
  return variant;
}
