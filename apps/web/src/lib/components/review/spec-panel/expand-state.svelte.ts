/**
 * Which rows of a spec panel are open. "Expand all" / "Collapse all" sets an
 * override for every row; toggling one row under the override copies it onto
 * each row first, so the other rows stay as they were.
 */
export function createExpandState(rowIds: () => readonly string[], initialAll: boolean | null) {
  let all = $state<boolean | null>(initialAll);
  let rows = $state<Record<string, boolean>>({});

  return {
    /** The override, or null once a single row has been toggled. */
    get all(): boolean | null {
      return all;
    },
    isOpen(id: string): boolean {
      return all ?? rows[id] ?? false;
    },
    toggle(id: string): void {
      if (all !== null) {
        const snapshot: Record<string, boolean> = {};
        for (const rowId of rowIds()) snapshot[rowId] = all;
        snapshot[id] = !all;
        rows = snapshot;
        all = null;
        return;
      }
      rows = { ...rows, [id]: !(rows[id] ?? false) };
    },
    toggleAll(): void {
      all = !(all === true || rowIds().some((id) => rows[id] === true));
      rows = {};
    },
  };
}
