import { isTextEditingKeyTarget } from "$lib/utils";

interface Options {
  /** Ids of the rows the arrow keys may land on, in display order. */
  order: () => readonly string[];
  /** Bound to `e`. */
  toggleAll: () => void;
  /** Extra single-key shortcuts for the focused row. */
  rowKeys?: Record<string, (id: string) => void>;
}

/**
 * Keyboard for a spec panel: `e` toggles expand-all, ArrowUp/Down (or k/j),
 * Home and End move focus between row triggers.
 */
export function createRowKeys({ order, toggleAll, rowKeys = {} }: Options) {
  const triggers = new Map<string, HTMLElement>();

  function focusedId(target: EventTarget | null): string | undefined {
    if (!(target instanceof Node)) return undefined;
    for (const [id, el] of triggers) if (el.contains(target)) return id;
    return undefined;
  }

  return {
    /** Ref callback for a row's trigger. */
    trigger(id: string): (el: HTMLElement | null) => void {
      return (el) => {
        if (el) triggers.set(id, el);
        else triggers.delete(id);
      };
    },
    onkeydown(e: KeyboardEvent): void {
      if (isTextEditingKeyTarget(e)) return;
      const plain = !e.metaKey && !e.ctrlKey && !e.altKey;
      if (plain && e.key === "e") {
        e.preventDefault();
        toggleAll();
        return;
      }

      const id = focusedId(e.target);
      if (id === undefined) return;
      const ids = order();
      const idx = ids.indexOf(id);
      if (idx < 0) return;

      const rowKey = rowKeys[e.key];
      if (rowKey) {
        if (plain) {
          e.preventDefault();
          rowKey(id);
        }
        return;
      }

      let next: string | undefined;
      if (e.key === "ArrowDown" || e.key === "j") next = ids[Math.min(idx + 1, ids.length - 1)];
      else if (e.key === "ArrowUp" || e.key === "k") next = ids[Math.max(idx - 1, 0)];
      else if (e.key === "Home") next = ids[0];
      else if (e.key === "End") next = ids[ids.length - 1];
      else return;
      e.preventDefault();
      if (next !== undefined) triggers.get(next)?.focus();
    },
  };
}
