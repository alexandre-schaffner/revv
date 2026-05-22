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
