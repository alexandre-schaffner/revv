// File icons identical to the sidebar's `@pierre/trees` tree, for light-DOM
// file lists. The tree keeps its sprite inside its shadow DOM, so we inject our
// own copy of the same sprite sheet and resolve icons with the library's own
// resolver (default config: the `'complete'` set, colored).
//
// The tree's icon colors are custom properties on its shadow `:host`, which
// never reach the light DOM, and the library doesn't export its stylesheet, so
// we lift those declarations out of the CSS `preloadFileTree` inlines and
// re-declare them on `:root`. They are `light-dark()` values, so they follow
// `<html>`'s `color-scheme`.

import { createFileTreeIconResolver, getBuiltInSpriteSheet } from "@pierre/trees";
import { preloadFileTree } from "@pierre/trees/ssr";

const SPRITE_ELEMENT_ID = "revv-file-icon-sprite";
const ICON_COLORS_ELEMENT_ID = "revv-file-icon-colors";
const ICON_COLOR_DECLARATION = /(--trees-(?:icon|file-icon-color)-[\w-]+)\s*:\s*([^;]+);/g;

let resolver: ReturnType<typeof createFileTreeIconResolver> | null = null;

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

function ensureIconColors(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(ICON_COLORS_ELEMENT_ID)) return;
  const css = /<style[^>]*>([\s\S]*?)<\/style>/.exec(
    preloadFileTree({ paths: [] }).shadowHtml,
  )?.[1];
  if (!css) return;
  const declarations = [...css.matchAll(ICON_COLOR_DECLARATION)].map(
    ([, name, value]) => `${name}: ${value};`,
  );
  const style = document.createElement("style");
  style.id = ICON_COLORS_ELEMENT_ID;
  style.textContent = `:root { ${declarations.join(" ")} }`;
  document.head.appendChild(style);
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

export function fileIcon(path: string): FileIcon {
  ensureSprite();
  ensureIconColors();
  resolver ??= createFileTreeIconResolver();
  const resolved = resolver.resolveIcon("file-tree-icon-file", path);
  return {
    symbolId: resolved.name,
    color: resolved.token
      ? `var(--trees-file-icon-color-${resolved.token}, var(--trees-file-icon-color-default))`
      : undefined,
  };
}
