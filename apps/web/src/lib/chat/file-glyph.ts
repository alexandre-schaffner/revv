import { fileIcon } from "$lib/utils/file-icon";
import { basename } from "$lib/utils/path";

const SVG_NS = "http://www.w3.org/2000/svg";

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

/**
 * Append a file pill's inert glyph and basename label to `host`. Callers stamp
 * their own behavior (a `contentEditable=false` token, a clickable `role`) on
 * the host itself.
 */
export function appendPillContents(
  host: HTMLElement,
  path: string,
  iconClass: string,
  labelClass?: string,
): void {
  host.appendChild(createFileGlyph(path, iconClass));
  const label = document.createElement("span");
  if (labelClass) label.className = labelClass;
  label.textContent = basename(path);
  host.appendChild(label);
}
