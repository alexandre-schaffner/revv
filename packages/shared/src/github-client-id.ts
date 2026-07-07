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
