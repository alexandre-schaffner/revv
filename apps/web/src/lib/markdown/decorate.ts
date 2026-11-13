import type { ActionReturn } from "svelte/action";

/**
 * Post-processing over rendered markdown: chips, pills, diagrams. `apply`
 * brings the DOM under the root up to date with `value`, from whatever is
 * there now, and may be async.
 */
export interface Decoration<T> {
  apply(value: T): void | Promise<void>;
  destroy?(): void;
}

/**
 * An action that keeps a decoration applied to the markdown under its node.
 *
 * It re-applies after every change to the subtree (a `{@html}` swap, a
 * streamed chunk) and every new value, coalesced into one microtask so it
 * runs after Svelte has patched the DOM. The decoration's own synchronous
 * writes don't schedule another pass. An async apply is never overlapped:
 * a change that lands while it runs gets one more pass afterwards.
 */
export function decorationAction<T>(
  create: (root: HTMLElement) => Decoration<T>,
): (node: HTMLElement, initial: T) => ActionReturn<T> {
  return (node, initial) => {
    const decoration = create(node);
    let value = initial;
    let destroyed = false;
    let scheduled = false;
    let running = false;
    let again = false;

    const schedule = (): void => {
      if (destroyed) return;
      if (running) {
        again = true;
        return;
      }
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(run);
    };

    const run = (): void => {
      scheduled = false;
      if (destroyed) return;
      const pending = decoration.apply(value);
      observer.takeRecords();
      if (!pending) return;
      running = true;
      void pending.finally(() => {
        running = false;
        if (again) {
          again = false;
          schedule();
        }
      });
    };

    const observer = new MutationObserver(schedule);
    observer.observe(node, { childList: true, subtree: true });
    schedule();

    return {
      update(next) {
        value = next;
        schedule();
      },
      destroy() {
        destroyed = true;
        observer.disconnect();
        decoration.destroy?.();
      },
    };
  };
}
