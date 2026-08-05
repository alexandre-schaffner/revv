import { type ClassValue, clsx } from "clsx";
import type { Snippet } from "svelte";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const TEXT_EDITING_SELECTOR =
  'input, textarea, select, [contenteditable="true"], [contenteditable="plaintext-only"], [role="textbox"]';
const TEXT_CONTROL_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

function getTagName(target: EventTarget): string | null {
  const tagName = (target as { tagName?: unknown }).tagName;
  return typeof tagName === "string" ? tagName.toUpperCase() : null;
}

function getAttribute(target: EventTarget, name: string): string | null {
  const value = (target as { getAttribute?: unknown }).getAttribute;
  return typeof value === "function" ? (value.call(target, name) as string | null) : null;
}

function closest(target: EventTarget, selector: string): Element | null {
  const value = (target as { closest?: unknown }).closest;
  return typeof value === "function" ? (value.call(target, selector) as Element | null) : null;
}

function isTextEditingTarget(target: EventTarget): boolean {
  if (
    (typeof HTMLInputElement !== "undefined" && target instanceof HTMLInputElement) ||
    (typeof HTMLTextAreaElement !== "undefined" && target instanceof HTMLTextAreaElement) ||
    (typeof HTMLSelectElement !== "undefined" && target instanceof HTMLSelectElement)
  ) {
    return true;
  }

  if (typeof HTMLElement !== "undefined" && target instanceof HTMLElement) {
    return (
      target.isContentEditable ||
      target.getAttribute("role") === "textbox" ||
      target.closest(TEXT_EDITING_SELECTOR) !== null
    );
  }

  if (target instanceof Object) {
    const tagName = getTagName(target);
    return (
      (tagName !== null && TEXT_CONTROL_TAGS.has(tagName)) ||
      (target as { isContentEditable?: unknown }).isContentEditable === true ||
      getAttribute(target, "role") === "textbox" ||
      closest(target, TEXT_EDITING_SELECTOR) !== null
    );
  }

  return false;
}

/**
 * True when a keyboard event originated from a surface where plain text input
 * should win over app-level single-key shortcuts.
 */
export function isTextEditingKeyTarget(e: KeyboardEvent): boolean {
  for (const target of e.composedPath()) {
    if (!target) continue;
    if (isTextEditingTarget(target)) return true;
  }

  return e.target ? isTextEditingTarget(e.target) : false;
}

export type WithElementRef<T, E extends Element = HTMLElement> = T & {
  ref?: E | null;
};

// Utility types used by shadcn-svelte components.
// We keep children accessible internally (components use {@render children?.()})
// but make it optional so consumers aren't required to pass it.
export type WithoutChild<T> = Omit<T, "children"> & { children?: Snippet };

export type WithoutChildrenOrChild<T> = Omit<T, "children"> & { children?: Snippet };
