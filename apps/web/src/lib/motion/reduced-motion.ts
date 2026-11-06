import { MediaQuery } from "svelte/reactivity";

let query: MediaQuery | null = null;

/**
 * The single reduced-motion arbiter across the app: every action, preset call
 * site, and motion `$effect` reads through here. Synchronous everywhere, and
 * reactive inside an effect or derived (it re-runs when the OS setting flips).
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  query ??= new MediaQuery("(prefers-reduced-motion: reduce)");
  return query.current;
}
