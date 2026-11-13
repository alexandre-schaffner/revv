// The server picks a blob's Content-Type from this and the web decides which
// diff files open in the image viewer, so both must agree on the extensions.

const IMAGE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
  // SVG is text, but its diffs are illegible noise, so it renders as an image.
  svg: "image/svg+xml",
};

function extensionOf(path: string): string {
  const slash = path.lastIndexOf("/");
  const base = slash === -1 ? path : path.slice(slash + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

export function isImagePath(path: string): boolean {
  const ext = extensionOf(path);
  return ext.length > 0 && ext in IMAGE_MIME_BY_EXTENSION;
}

/** `application/octet-stream` for an unknown extension; gate on {@link isImagePath} first. */
export function guessImageContentType(path: string): string {
  const ext = extensionOf(path);
  return IMAGE_MIME_BY_EXTENSION[ext] ?? "application/octet-stream";
}
