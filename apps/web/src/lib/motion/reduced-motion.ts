/**
 * Synchronous reduced-motion check. The single arbiter across the app —
 * every action, preset call site, and motion `$effect` reads through here.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
