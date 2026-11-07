import { isPublicGitHub, normalizeGithubHost, sameGithubHost } from "@revv/shared";
import { serverEnv } from "../config";

const PREFIX = "github:";

/**
 * Accounts created before Revv keyed them by host carry the bare better-auth
 * social-provider id (legacy-upgrade: providerIdWithoutHost). They belong to
 * the host the install was configured for.
 */
export const LEGACY_GITHUB_PROVIDER_ID = "github";

export function providerIdForHost(host: string): string {
  return `${PREFIX}${normalizeGithubHost(host)}`;
}

export function hostFromProviderId(providerId: string): string {
  if (providerId.startsWith(PREFIX)) return normalizeGithubHost(providerId.slice(PREFIX.length));
  return serverEnv.githubHost;
}

/** Whether an account row's provider id names `host`. */
export function isAccountOnHost(providerId: string, host: string): boolean {
  return sameGithubHost(hostFromProviderId(providerId), host);
}

/** github.com's REST API lives on `api.github.com`; a GitHub Enterprise host's on `api.<host>`. */
export function apiBaseForHost(host: string): string {
  return isPublicGitHub(host) ? "https://api.github.com" : `https://api.${host}`;
}
