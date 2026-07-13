// Pure change-detector for walkthrough store entries.
//
// Extracted from the `.svelte.ts` store so it can be unit-tested without the
// Svelte runtime. Used by `updateEntry` to skip the reactive `store.entries`
// write on a genuine no-op — which is what prevents an `$effect` that calls
// `updateEntry` (e.g. AppShell's new-commit watcher via `markWalkthroughStale`)
// from re-invalidating on its own output → `effect_update_depth_exceeded`
// (a hard UI freeze).
//
// A SHALLOW comparison is sound here specifically because `updateEntryInMap`
// freezes the existing entry's direct mutable field references before handing
// a shallow clone to the updater. Scalar assignments and reference replacements
// still work; in-place mutations like `entry.blocks.push(...)` throw instead
// of being mistaken for no-ops.

type MutableEntryMap<T extends object> = {
  get(key: string): T | undefined;
  set(key: string, value: T): unknown;
};

export type EntryUpdateResult = "missing" | "unchanged" | "changed";

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

function freezeMutableFieldReferences<T extends object>(entry: T): void {
  for (const value of Object.values(entry)) {
    if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
      Object.freeze(value);
    }
  }
}

/**
 * Shared write primitive for walkthrough entry maps.
 *
 * Updaters mutate a shallow clone. When they make a real change, they must
 * replace the changed field's reference; mutating existing field references in
 * place is rejected by shallow-freezing them first.
 */
export function updateEntryInMap<T extends object>(
  entries: MutableEntryMap<T>,
  key: string,
  updater: (entry: T) => void,
): EntryUpdateResult {
  const entry = entries.get(key);
  if (!entry) return "missing";

  freezeMutableFieldReferences(entry);
  const next = { ...entry };
  try {
    updater(next);
  } catch (error) {
    if (error instanceof TypeError) {
      throw new TypeError(
        "updateEntry updater attempted an in-place nested mutation; replace the field reference instead.",
      );
    }
    throw error;
  }

  if (shallowEntryEqual(entry, next)) return "unchanged";
  entries.set(key, next);
  return "changed";
}
