import { jsonCodec, persisted, STORAGE_KEYS } from "$lib/stores/persisted.svelte";

type Visits = Record<string, string>;

const visits = persisted<Visits>(
  STORAGE_KEYS.prVisits,
  jsonCodec((v) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Visits) : undefined)),
  {},
);

export function markVisited(prId: string, headSha: string | null): void {
  const next = headSha ?? "";
  if (visits.current[prId] === next) return;
  visits.current = { ...visits.current, [prId]: next };
}

/**
 * How much of this PR the viewer has already seen.
 *
 * `"moved"` is the state worth surfacing: you opened this PR, but the author
 * has pushed since, so what you read is stale. It's only distinguishable
 * because a visit records the head SHA rather than a boolean.
 */
export type VisitState = "unvisited" | "visited" | "moved";

export function getVisitState(prId: string, headSha: string | null): VisitState {
  const seen = visits.current[prId];
  if (seen === undefined) return "unvisited";
  // An empty recorded SHA is a visit from before the head was known; there's
  // nothing to compare, so don't claim it moved.
  if (seen === "" || headSha === null) return "visited";
  return seen === headSha ? "visited" : "moved";
}
