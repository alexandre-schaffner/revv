/** Thousands separators: a five-figure diff is the one worth reading twice. */
export function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}
