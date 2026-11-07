/**
 * The heads a stack action is pinned to, keyed by PR number: the server
 * refuses when any of them moved since the user saw them.
 */
export function expectedHeads(
  layers: readonly { readonly number: number; readonly headSha: string | null }[],
): Record<string, string> {
  return Object.fromEntries(
    layers.flatMap((l) => (l.headSha ? [[String(l.number), l.headSha]] : [])),
  );
}
