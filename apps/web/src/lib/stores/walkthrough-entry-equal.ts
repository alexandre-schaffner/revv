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
// freezes the existing entry's nested references before handing a shallow clone
// to the updater. Scalar assignments and reference replacements still work;
// in-place nested mutations throw instead of being mistaken for no-ops.

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

function freezeDeep(value: unknown, seen: WeakSet<object>): void {
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  for (const child of Object.values(value)) {
    freezeDeep(child, seen);
  }
  if (!Object.isFrozen(value)) {
    Object.freeze(value);
  }
}

function freezeNestedReferences<T extends object>(entry: T): void {
  const seen = new WeakSet<object>();
  for (const value of Object.values(entry)) {
    freezeDeep(value, seen);
  }
}

/**
 * Shared write primitive for walkthrough entry maps.
 *
 * Updaters mutate a shallow clone. When they make a real change, they must
 * replace the changed field's reference; mutating nested arrays/objects in
 * place is rejected by freezing the existing nested references first.
 */
export function updateEntryInMap<T extends object>(
  entries: MutableEntryMap<T>,
  key: string,
  updater: (entry: T) => void,
): EntryUpdateResult {
  const entry = entries.get(key);
  if (!entry) return "missing";

  freezeNestedReferences(entry);
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
