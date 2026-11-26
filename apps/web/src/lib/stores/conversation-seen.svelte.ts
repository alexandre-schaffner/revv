// When the viewer last had each PR's Conversation tab on screen, by the
// newest timeline item it showed then. The tab reads it on arrival to mark
// what happened since, and writes it on leaving, so the marks stay up for the
// whole visit. A view preference, not review state: localStorage, capped.
const STORAGE_KEY = "revv:conversation-seen";
const CAP = 300;

function load(): Record<string, string> {
  if (typeof localStorage === "undefined") return {};
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

let seen = $state<Record<string, string>>(load());

/** The newest timeline item the viewer saw on this PR, or null on a first visit. */
export function getConversationSeenAt(prId: string): string | null {
  return seen[prId] ?? null;
}

export function setConversationSeenAt(prId: string, at: string): void {
  if (seen[prId] === at) return;
  const next = { ...seen };
  delete next[prId];
  next[prId] = at;
  const ids = Object.keys(next);
  for (const id of ids.slice(0, Math.max(0, ids.length - CAP))) delete next[id];
  seen = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage full or unavailable: the marks reset next launch, nothing worse.
  }
}
