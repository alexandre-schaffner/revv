// The bound is in UTF-16 code units (`String.length`), not bytes: a cheap proxy
// for "too large for the model / to scan synchronously", since diffs are mostly
// ASCII. Callers name their limits `*_CHARS` to match.

/**
 * Clip `patch` to `maxChars`, appending a marker with the original length so a
 * reader (human or agent) knows it was cut.
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
