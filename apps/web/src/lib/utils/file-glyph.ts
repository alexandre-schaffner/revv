// ── File-type glyph (DOM) ────────────────────────────────────────────────────
//
// Builds the per-extension file-type `<svg><use href="#symbol">` glyph (the same
// one the sidebar tree and the tool-call detail pill render) as a detached SVG
// element. Shared by the `fileReferences` and `mentionReferences` actions, which
// inject glyphs into already-rendered markdown via the DOM rather than a Svelte
// template — so they can't use the component form and built this by hand before.

import { fileIcon } from "$lib/utils/file-icon";

const SVG_NS = "http://www.w3.org/2000/svg";

/** A detached `<svg>` file-type glyph for `path`, tagged with `className`. */
export function createFileGlyph(path: string, className: string): SVGSVGElement {
  const { symbolId, color } = fileIcon(path);
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", className);
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  if (color) svg.style.color = color;
  const use = document.createElementNS(SVG_NS, "use");
  use.setAttribute("href", `#${symbolId}`);
  svg.appendChild(use);
  return svg;
}
