import { type ClassValue, clsx } from "clsx";
import type { Snippet } from "svelte";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * True when a keyboard event originated from a surface where plain text input
 * should win over app-level single-key shortcuts.
 */
export function isTextEditingKeyTarget(e: KeyboardEvent): boolean {
  for (const target of e.composedPath()) {
    if (!(target instanceof HTMLElement)) continue;
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement
    ) {
      return true;
    }
    if (target.isContentEditable || target.getAttribute("role") === "textbox") {
      return true;
    }
  }

  if (!(e.target instanceof Node)) return false;
  const target = e.target instanceof Element ? e.target : e.target.parentElement;
  return Boolean(
    target?.closest(
      'input, textarea, select, [contenteditable="true"], [contenteditable="plaintext-only"], [role="textbox"]',
    ),
  );
}

export type WithElementRef<T, E extends Element = HTMLElement> = T & {
  ref?: E | null;
};

// Utility types used by shadcn-svelte components.
// We keep children accessible internally (components use {@render children?.()})
// but make it optional so consumers aren't required to pass it.
export type WithoutChild<T> = Omit<T, "children"> & { children?: Snippet };

export type WithoutChildrenOrChild<T> = Omit<T, "children"> & { children?: Snippet };
