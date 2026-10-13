/**
 * Open a URL in the user's browser. In the Tauri shell a plain navigation
 * would replace the app's own webview, so links leave through the opener
 * plugin; in a bare browser (dev) a new tab stands in.
 */
export async function openExternal(url: string): Promise<void> {
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } catch {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

/**
 * Click handler for a container of rendered markdown: route its http(s)
 * links through {@link openExternal} instead of navigating the webview.
 */
export function interceptExternalLinks(event: MouseEvent): void {
  if (!(event.target instanceof Element)) return;
  const anchor = event.target.closest("a[href]");
  if (!(anchor instanceof HTMLAnchorElement)) return;
  if (anchor.protocol !== "http:" && anchor.protocol !== "https:") return;
  event.preventDefault();
  void openExternal(anchor.href);
}
