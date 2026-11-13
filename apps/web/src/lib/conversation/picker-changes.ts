/** Changes made since opening a picker, independent of later server refreshes. */
export function pickerChanges<T>(before: ReadonlyMap<string, T>, draft: ReadonlySet<string>) {
  return {
    addedKeys: [...draft].filter((key) => !before.has(key)),
    removed: [...before].flatMap(([key, item]) => (draft.has(key) ? [] : [item])),
  };
}
