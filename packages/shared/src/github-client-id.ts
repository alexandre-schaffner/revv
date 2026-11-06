export const GITHUB_CLIENT_ID_HINT =
  "GitHub client IDs start with Iv for GitHub Apps or Ov for OAuth Apps.";

/**
 * GitHub App client IDs currently start with `Iv`; classic OAuth App client
 * IDs start with `Ov`. Keep this as a shape check only: GitHub remains the
 * authority for whether the id exists on a given host.
 */
export function isLikelyGitHubClientId(value: string): boolean {
  return /^(Iv|Ov)[A-Za-z0-9]{8,}$/.test(value.trim());
}

/**
 * The client ID saved in settings for `host`, or null. A saved ID belongs to
 * the GitHub Enterprise host it was entered with and is never sent to any
 * other host: github.com always signs in through Revv's bundled registration.
 */
export function savedClientIdForHost(
  host: string,
  saved: { readonly githubHost: string; readonly githubClientId: string },
): string | null {
  const target = host.trim().toLowerCase();
  if (target === "github.com") return null;
  if (saved.githubHost.trim().toLowerCase() !== target) return null;
  const clientId = saved.githubClientId.trim();
  return clientId === "" ? null : clientId;
}
