// ── Image file helpers ───────────────────────────────────────────────────────
//
// Shared between the server (Content-Type negotiation when serving raw blob
// bytes from a PR file-blob route) and the web client (decide whether a
// binary diff file should render through the image viewer). Both sides must
// agree on the set of extensions; the canonical list lives here.

const IMAGE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
  // SVG is text-encoded XML but most diffs are illegible character noise;
  // we treat it as image-rendered here. The file-blob route still streams
  // the literal bytes — browsers handle SVG mime sniffing fine.
  svg: "image/svg+xml",
};

function extensionOf(path: string): string {
  const slash = path.lastIndexOf("/");
  const base = slash === -1 ? path : path.slice(slash + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

/** True when the path's extension is one of the recognized image types. */
export function isImagePath(path: string): boolean {
  const ext = extensionOf(path);
  return ext.length > 0 && ext in IMAGE_MIME_BY_EXTENSION;
}

/**
 * Best-effort MIME for an image path. Returns
 * `application/octet-stream` when the extension isn't a known image type —
 * callers should typically gate on {@link isImagePath} first.
 */
export function guessImageContentType(path: string): string {
  const ext = extensionOf(path);
  return IMAGE_MIME_BY_EXTENSION[ext] ?? "application/octet-stream";
}
