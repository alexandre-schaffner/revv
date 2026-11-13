import { isPublicGitHub, sameGithubHost } from "./github-host";

export const GITHUB_CLIENT_ID_HINT =
  "GitHub client IDs start with Iv for GitHub Apps or Ov for OAuth Apps.";

const CLIENT_ID = /^(Iv|Ov)[A-Za-z0-9]{8,}$/;

/**
 * Which kind of registration a client id belongs to, by its shape: GitHub App
 * client IDs currently start with `Iv`, classic OAuth App client IDs with
 * `Ov`. Null for neither. A shape check only: GitHub remains the authority
 * for whether the id exists on a given host.
 */
export function clientIdKind(value: string): "github-app" | "oauth-app" | null {
  const prefix = CLIENT_ID.exec(value.trim())?.[1];
  if (prefix === "Iv") return "github-app";
  if (prefix === "Ov") return "oauth-app";
  return null;
}

export function isLikelyGitHubClientId(value: string): boolean {
  return clientIdKind(value) !== null;
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
  if (isPublicGitHub(host) || !sameGithubHost(saved.githubHost, host)) return null;
  const clientId = saved.githubClientId.trim();
  return clientId === "" ? null : clientId;
}
