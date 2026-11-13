/** The success body of an Eden call, e.g. `EdenData<typeof api.api.settings.get>`. */
export type EdenData<Call extends (...args: never[]) => Promise<{ data: unknown }>> = NonNullable<
  Awaited<ReturnType<Call>>["data"]
>;

export function thrownMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
