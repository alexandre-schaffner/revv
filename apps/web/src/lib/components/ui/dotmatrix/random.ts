// ── Random variant picker for streaming chat ───────────────────────────────
// Given a stable id (typically the assistant message UUID created in
// `chat.svelte.ts` per turn), pick one of the chat-eligible variants
// deterministically. Pure: same id → same variant; new id → fresh roll.
// No store/DB writes needed.
//
// Exclusions: all four variants used by `GuidedWalkthrough.svelte`
// (`ripple`, `diagonal`, `collapse`, `prism-bloom`) are kept out of the chat
// pool so the chat doesn't end up looking like the walkthrough panel.
// `square-14` shares its config with `prism-bloom` (kaleidoscope palindrome),
// so it's excluded too. Effective pool: 19 picks.

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

// FNV-1a 32-bit. Small, deterministic, more uniform than `id.length % N`.
function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function squareVariantForId(id: string): DotmatrixVariant {
  const idx = fnv1a(id) % CHAT_VARIANT_POOL.length;
  const variant = CHAT_VARIANT_POOL[idx];
  if (!variant) throw new Error(`Invalid variant index: ${idx}`);
  return variant;
}
