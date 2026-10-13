import { toast } from "svelte-sonner";

/**
 * Schemes a link from GitHub content may hand to the OS. URLs here come from
 * third parties (check `detailsUrl`s set by CI integrations, comment bodies),
 * so anything else (`file:`, custom app schemes) is refused.
 */
const EXTERNAL_SCHEMES = new Set(["http:", "https:", "mailto:"]);

function isOpenable(url: string): boolean {
  try {
    return EXTERNAL_SCHEMES.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

/**
 * Open a URL in the user's browser through the Tauri opener plugin; a plain
 * navigation would replace the app's own webview.
 */
export async function openExternal(url: string): Promise<void> {
  if (!isOpenable(url)) return;
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } catch {
    toast.error("Couldn't open the link.");
  }
}

/**
 * Click handler for a container of rendered markdown: links leave through
 * {@link openExternal} and never navigate the webview. In-page anchors
 * (`#…`) keep their default.
 */
export function interceptExternalLinks(event: MouseEvent): void {
  if (!(event.target instanceof Element)) return;
  const anchor = event.target.closest("a[href]");
  if (!(anchor instanceof HTMLAnchorElement)) return;
  if (anchor.getAttribute("href")?.startsWith("#")) return;
  event.preventDefault();
  void openExternal(anchor.href);
}
