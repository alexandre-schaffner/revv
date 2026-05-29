import { serverEnv } from "./config";

/**
 * Per-host GitHub OAuth wiring shared by the device-code sign-in flow
 * (`routes/device-auth.ts`) and the token-refresh path (`TokenProvider`).
 *
 * Revv targets github.com with a public OAuth App and any GitHub Enterprise
 * host with the bundled GHE OAuth App. The device-code flow — including its
 * `refresh_token` grant — never needs a `client_secret`.
 */

/** `true` for public github.com, `false` for any GitHub Enterprise host. */
export function isPublicGitHub(host: string): boolean {
  return host === "github.com";
}

/**
 * OAuth App client_id for a host. Throws a clear error when targeting
 * github.com without `GITHUB_CLIENT_ID_PUBLIC` configured, so the user gets a
 * diagnosable message instead of GitHub's opaque "invalid client".
 */
export function clientIdForHost(host: string): string {
  if (isPublicGitHub(host)) {
    if (!serverEnv.githubClientIdPublic) {
      throw new Error(
        "Public GitHub sign-in requires GITHUB_CLIENT_ID_PUBLIC to be set. " +
          "Register an OAuth App on github.com and add GITHUB_CLIENT_ID_PUBLIC=<id> to your .env file.",
      );
    }
    return serverEnv.githubClientIdPublic;
  }
  return serverEnv.githubClientId;
}

/** OAuth token endpoint (used for both device-code exchange and refresh). */
export function tokenUrlForHost(host: string): string {
  return `https://${host}/login/oauth/access_token`;
}
