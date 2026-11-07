// A `prlens` fence leaves the renderer as a placeholder carrying its source,
// and the diagrams decoration draws it. The source is UTF-8 encoded before
// base64 because `btoa` only accepts Latin-1.

const SOURCE_ATTR = "data-prlens-src";

export const DIAGRAM_SELECTOR = `.prlens-diagram[${SOURCE_ATTR}]`;

export function diagramPlaceholder(source: string): string {
  const bytes = new TextEncoder().encode(source);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `<div class="prlens-diagram not-prose" ${SOURCE_ATTR}="${btoa(binary)}"><span class="prlens-loading">Rendering diagram...</span></div>`;
}

export function diagramSource(placeholder: HTMLElement): string | null {
  const encoded = placeholder.getAttribute(SOURCE_ATTR);
  if (encoded === null) return null;
  try {
    const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}
