// ── Random variant picker for streaming chat ───────────────────────────────
// Given a stable id (the chat's turn id), pick one of the chat-eligible variants
// deterministically. Pure: same id → same variant; new id → fresh roll.
// No store/DB writes needed.
//
// Exclusions: all four variants used by `GuidedWalkthrough.svelte`
// (`ripple`, `diagonal`, `collapse`, `prism-bloom`) are kept out of the chat
// pool so the chat doesn't end up looking like the walkthrough panel.
// `square-14` shares its config with `prism-bloom` (kaleidoscope palindrome),
// so it's excluded too. Effective pool: 19 picks.

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
