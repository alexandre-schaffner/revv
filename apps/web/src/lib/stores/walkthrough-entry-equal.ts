// Pure change-detector for walkthrough store entries.
//
// Extracted from the `.svelte.ts` store so it can be unit-tested without the
// Svelte runtime. Used by `updateEntry` to skip the reactive `store.entries`
// write on a genuine no-op — which is what prevents an `$effect` that calls
// `updateEntry` (e.g. AppShell's new-commit watcher via `markWalkthroughStale`)
// from re-invalidating on its own output → `effect_update_depth_exceeded`
// (a hard UI freeze).
//
// A SHALLOW comparison is sound here specifically because every store updater
// replaces a field's reference when it changes it (immutable updates:
// `entry.blocks = [...]`, `entry.explorationResults = {...}`, scalar
// reassignments). So a `!==` on any own key means a real change, and all-equal
// means a genuine no-op. In-place nested mutation would defeat this — don't
// introduce it in an updater.

/**
 * True when `a` and `b` have identical own enumerable keys with `===`-equal
 * values (or are the same reference). `b` is expected to be a shallow clone of
 * `a` (`{ ...a }`) that an updater may have mutated, so the key sets match by
 * construction; the length guard is defensive.
 */
export function shallowEntryEqual<T extends object>(a: T, b: T): boolean {
  if (a === b) return true;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if ((a as Record<string, unknown>)[key] !== (b as Record<string, unknown>)[key]) {
      return false;
    }
  }
  return true;
}
