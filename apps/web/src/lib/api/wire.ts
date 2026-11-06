/** The success body of an Eden call, e.g. `EdenData<typeof api.api.settings.get>`. */
export type EdenData<Call extends (...args: never[]) => Promise<{ data: unknown }>> = NonNullable<
  Awaited<ReturnType<Call>>["data"]
>;

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
