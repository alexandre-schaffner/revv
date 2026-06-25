// ── File-type icons (shared with the sidebar file tree) ────────────────────
//
// The sidebar file tree (`@pierre/trees` `FileTree`) renders per-extension,
// colored file icons from a built-in SVG sprite set. Anywhere else we list
// files — the composer's `@`-mention menu, for one — should use the SAME icons
// so a `.ts`/`.svelte`/`.json` reads identically across the app.
//
// `@pierre/trees` keeps its sprite inside the tree's shadow DOM, so light-DOM
// callers can't reference those symbols. We inject our own copy of the same
// sprite sheet once and resolve icons with the library's own resolver, which
// guarantees byte-identical icon selection to the tree (default config: the
// `'complete'` set, colored). Colors come back as `light-dark()` CSS values that
// follow `<html>`'s `color-scheme` (set by the theme store), so they theme for
// free — no per-call theme wiring needed.

import {
  createFileTreeIconResolver,
  getBuiltInFileIconColor,
  getBuiltInSpriteSheet,
} from "@pierre/trees";

const SPRITE_ELEMENT_ID = "revv-file-icon-sprite";

// Lazily created — pure, no DOM dependency, so it also works under SSR.
let resolver: ReturnType<typeof createFileTreeIconResolver> | null = null;

/** Inject the built-in sprite sheet into the light DOM once (browser only). */
function ensureSprite(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(SPRITE_ELEMENT_ID)) return;
  // getBuiltInSpriteSheet returns a full `<svg data-icon-sprite>…</svg>` string.
  const template = document.createElement("template");
  template.innerHTML = getBuiltInSpriteSheet("complete").trim();
  const svg = template.content.firstElementChild;
  if (!(svg instanceof SVGElement)) return;
  svg.id = SPRITE_ELEMENT_ID;
  document.body.appendChild(svg);
}

export interface FileIcon {
  /** Sprite `<symbol>` id to reference via `<use href="#…">`. */
  readonly symbolId: string;
  /**
   * CSS color for the icon (the icons paint with `fill="currentColor"`), or
   * `undefined` for the generic file icon, which then inherits the text color.
   */
  readonly color: string | undefined;
}

/**
 * Resolve the file-tree icon for a path. Matches the sidebar tree exactly,
 * including per-extension color. Falls back to the generic file glyph for
 * unknown types.
 */
export function fileIcon(path: string): FileIcon {
  ensureSprite();
  resolver ??= createFileTreeIconResolver();
  const resolved = resolver.resolveIcon("file-tree-icon-file", path);
  return {
    symbolId: resolved.name,
    color: resolved.token ? getBuiltInFileIconColor(resolved.token) : undefined,
  };
}
