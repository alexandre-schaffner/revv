/**
 * Eden revives ISO strings into `Date`s on the way in; the shared types say
 * `string`, and SSE delivers strings. A JSON round trip puts them back, so
 * code downstream never has to ask which one it holds.
 */
export function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function thrownMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

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
