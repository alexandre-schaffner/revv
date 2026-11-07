// `updateEntry` skips the reactive `store.entries` write on a no-op, so an
// `$effect` that calls it can't re-invalidate on its own output (Svelte's
// `effect_update_depth_exceeded`, a hard UI freeze).
//
// A shallow comparison is sound because `updateEntryInMap` freezes the entry's
// direct field references before handing a clone to the updater: in-place
// mutations like `entry.blocks.push(...)` throw instead of passing for no-ops.

type MutableEntryMap<T extends object> = {
  get(key: string): T | undefined;
  set(key: string, value: T): unknown;
};

export type EntryUpdateResult = "missing" | "unchanged" | "changed";

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
 * Updaters mutate a shallow clone. A real change must replace the changed
 * field's reference; mutating an existing field reference in place throws.
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
