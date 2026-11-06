// A `prlens` fence leaves the renderer as a placeholder carrying its source,
// and the diagrams decoration draws it. The source rides in a data attribute
// as UTF-8 base64, so multi-byte text survives the round-trip.

const SOURCE_ATTR = "data-prlens-src";

export const DIAGRAM_SELECTOR = `.prlens-diagram[${SOURCE_ATTR}]`;

export function diagramPlaceholder(source: string): string {
  const bytes = new TextEncoder().encode(source);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `<div class="prlens-diagram not-prose" ${SOURCE_ATTR}="${btoa(binary)}"><span class="prlens-loading">Rendering diagram...</span></div>`;
}

/** The fence source a placeholder carries; null when it can't be decoded. */
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
