import { serverEnv } from "../config";

const PREFIX = "github:";

/**
 * Accounts created before Revv keyed them by host carry the bare better-auth
 * social-provider id. They belong to the host the install was configured for.
 */
export const LEGACY_GITHUB_PROVIDER_ID = "github";

export function providerIdForHost(host: string): string {
  return `${PREFIX}${host}`;
}

export function hostFromProviderId(providerId: string): string {
  if (providerId.startsWith(PREFIX)) return providerId.slice(PREFIX.length);
  return serverEnv.githubHost;
}
