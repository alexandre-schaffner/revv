const STORAGE_KEY = "rev_pr_visits";

type Visits = Record<string, string>;

function loadVisits(): Visits {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Visits;
    }
    return {};
  } catch {
    return {};
  }
}

let visits = $state<Visits>(loadVisits());

function persist(): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(visits));
  } catch {
    // Quota or serialization failure — visits become session-only.
  }
}

export function markVisited(prId: string, headSha: string | null): void {
  const next = headSha ?? "";
  if (visits[prId] === next) return;
  visits = { ...visits, [prId]: next };
  persist();
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
  const seen = visits[prId];
  if (seen === undefined) return "unvisited";
  // An empty recorded SHA is a visit from before the head was known; there's
  // nothing to compare, so don't claim it moved.
  if (seen === "" || headSha === null) return "visited";
  return seen === headSha ? "visited" : "moved";
}
