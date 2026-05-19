import { goto } from "$app/navigation";
import { getArchivedPrs, getPullRequests, getRepositories } from "$lib/stores/prs.svelte";

/**
 * Resolve a GitHub PR URL to a Revv internal `/review/{prId}` path.
 * Returns null when the PR is not in the local store.
 *
 * Strategy:
 *  1. Direct URL match against `pr.url` (most reliable — avoids URL parsing).
 *  2. Pattern match: parse {host}/{owner}/{repo}/pull/{number} and cross-
 *     reference the repository list by fullName.
 */
export function resolveGithubPrUrl(href: string): string | null {
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const normalized = href.split("?")[0]!.split("#")[0]!.replace(/\/$/, "");

  const allPrs = [...getPullRequests(), ...getArchivedPrs()];

  // Direct match against the PR's stored GitHub URL
  const exact = allPrs.find((pr) => {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const prUrl = pr.url.split("?")[0]!.split("#")[0]!.replace(/\/$/, "");
    return prUrl === normalized;
  });
  if (exact) return `/review/${exact.id}`;

  // Pattern fallback
  const m = href.match(/^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!m) return null;
  const owner = m[1];
  const repo = m[2];
  const prNumStr = m[3];
  if (!owner || !repo || !prNumStr) return null;
  const prNumber = parseInt(prNumStr, 10);
  const fullName = `${owner}/${repo}`;

  const repos = getRepositories();
  const matchingRepo = repos.find((r) => r.fullName === fullName);
  if (!matchingRepo) return null;

  const pr = allPrs.find((p) => p.repositoryId === matchingRepo.id && p.externalId === prNumber);
  return pr ? `/review/${pr.id}` : null;
}

/**
 * Open a URL in the user's default browser.
 * Uses Tauri's opener plugin when available, falls back to window.open.
 */
export async function openExternal(href: string): Promise<void> {
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(href);
  } catch {
    window.open(href, "_blank", "noopener,noreferrer");
  }
}

/**
 * Click-event handler for containers with {@html} rendered markdown.
 *
 * - Prevents default browser navigation for every <a> tag.
 * - Maps GitHub PR URLs to Revv internal /review routes.
 * - Opens all other absolute URLs in the default browser (Tauri-aware).
 * - Passes relative/anchor paths to SvelteKit's goto.
 *
 * Usage:
 *   <div onclick={handleMarkdownLinkClick}>{@html html}</div>
 */
export function handleMarkdownLinkClick(e: MouseEvent): void {
  const target = e.target as HTMLElement;
  const link = target.closest("a");
  if (!link) return;

  e.preventDefault();

  const href = link.getAttribute("href");
  if (!href) return;

  // Relative paths or anchors — hand off to SvelteKit
  if (!href.includes("://")) {
    void goto(href);
    return;
  }

  // GitHub PR → Revv internal route
  const internalPath = resolveGithubPrUrl(href);
  if (internalPath) {
    void goto(internalPath);
    return;
  }

  // Everything else: open in browser
  void openExternal(href);
}
