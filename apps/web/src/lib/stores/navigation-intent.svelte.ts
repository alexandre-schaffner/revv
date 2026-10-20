// ── Navigation intent ───────────────────────────────────────────────────────
//
// Which way the next page is coming from, for the AppShell page slot. Moving
// up a PR stack, the new layer drops in from above; moving down, it rises
// from below; anything else crossfades. Set just before navigating, read once
// by the page that mounts next.
//
// Deliberately not `$state`: nothing renders from it, and the page slot reads
// it from inside a transition, where a reactive write would be unsafe.

export type NavigationDirection = "up" | "down";

/** An intent older than this belongs to a navigation that never happened. */
const FRESH_FOR_MS = 1500;

let intent: { readonly direction: NavigationDirection; readonly at: number } | null = null;

export function setNavigationIntent(direction: NavigationDirection): void {
  intent = { direction, at: performance.now() };
}

/** The pending direction, consumed: a second read returns null. */
export function takeNavigationIntent(): NavigationDirection | null {
  const pending = intent;
  intent = null;
  if (!pending || performance.now() - pending.at > FRESH_FOR_MS) return null;
  return pending.direction;
}
