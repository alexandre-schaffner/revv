import type { PullRequest } from "@revv/shared";

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
 * The dot is meant to nudge the user toward PRs that need their attention,
 * so it only ever applies to PRs they author or are tagged to review.
 * Within that set, the dot shows when either the PR has never been opened
 * on this device or its head SHA has changed since the last visit (i.e. a
 * new commit was pushed).
 */
export function isPrUnseen(pr: PullRequest, currentUserLogin: string | null): boolean {
  if (!currentUserLogin) return false;
  const isOwn = pr.authorLogin === currentUserLogin;
  const isReviewer = pr.requestedReviewers.includes(currentUserLogin);
  if (!isOwn && !isReviewer) return false;
  const visited = visits[pr.id];
  if (visited === undefined) return true;
  return visited !== (pr.headSha ?? "");
}
