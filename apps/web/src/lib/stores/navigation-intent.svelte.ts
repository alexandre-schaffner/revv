export type NavigationDirection = "up" | "down";

const FRESH_FOR_MS = 1500;

let intent: { readonly direction: NavigationDirection; readonly at: number } | null = null;

export function setNavigationIntent(direction: NavigationDirection): void {
  intent = { direction, at: performance.now() };
}

export function takeNavigationIntent(): NavigationDirection | null {
  const pending = intent;
  intent = null;
  if (!pending || performance.now() - pending.at > FRESH_FOR_MS) return null;
  return pending.direction;
}
