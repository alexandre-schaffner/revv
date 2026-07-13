// ── Shared patch truncation ──────────────────────────────────────────────────
//
// One primitive for clipping an oversized diff/patch string, used by both the
// incremental walkthrough diff builder (`incremental-diff.ts`) and the recap
// source bundle (`recap-source-bundle.ts`). Keeping it in one place avoids two
// subtly-different truncation markers drifting apart.
//
// The bound is measured in UTF-16 code units (`String.length`), NOT bytes — a
// hard character cap is a cheap, good-enough proxy for "too large for the model
// / too large to scan synchronously" given diffs are line-oriented ASCII in
// practice. Callers name their limits `*_CHARS` to reflect this.

/**
 * Clip `patch` to at most `maxChars` UTF-16 code units, appending a marker that
 * records the original length so a reader (human or agent) knows it was cut.
 * Returns the patch unchanged with `truncated: false` when it already fits.
 */
export function truncatePatchToChars(
  patch: string,
  maxChars: number,
  label: string,
): { readonly patch: string; readonly truncated: boolean } {
  if (patch.length <= maxChars) return { patch, truncated: false };
  return {
    patch: `${patch.slice(0, maxChars)}\n[…${label} truncated to ${maxChars} chars — original ${patch.length}…]`,
    truncated: true,
  };
}
