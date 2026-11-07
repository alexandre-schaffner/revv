import { isPublicGitHub } from "@revv/shared";
import { serverEnv } from "../config";

const PREFIX = "github:";

/**
 * Accounts created before Revv keyed them by host carry the bare better-auth
 * social-provider id (legacy-upgrade: providerIdWithoutHost). They belong to
 * the host the install was configured for.
 */
export const LEGACY_GITHUB_PROVIDER_ID = "github";

export function providerIdForHost(host: string): string {
  return `${PREFIX}${host}`;
}

export function hostFromProviderId(providerId: string): string {
  if (providerId.startsWith(PREFIX)) return providerId.slice(PREFIX.length);
  return serverEnv.githubHost;
}

export function providerIdsForHost(host: string): string[] {
  return host === serverEnv.githubHost
    ? [providerIdForHost(host), LEGACY_GITHUB_PROVIDER_ID]
    : [providerIdForHost(host)];
}

/** github.com's REST API lives on `api.github.com`; a GitHub Enterprise host's on `api.<host>`. */
export function apiBaseForHost(host: string): string {
  return isPublicGitHub(host) ? "https://api.github.com" : `https://api.${host}`;
}
