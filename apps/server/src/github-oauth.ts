import { GITHUB_CLIENT_ID_HINT, isLikelyGitHubClientId, savedClientIdForHost } from "@revv/shared";
import { serverEnv } from "./config";
import { isPublicGitHub } from "./domain/github-host";

/**
 * Per-host GitHub OAuth wiring shared by the device-code sign-in flow
 * (`routes/device-auth.ts`) and the token-refresh grant (`GitHubAccounts`).
 *
 * Revv targets github.com with a bundled public OAuth App (or, in Pro, a
 * bundled GitHub App), and any GitHub Enterprise host with a client ID the
 * user supplies during onboarding — no GHE host is baked in. The device-code
 * flow — including its `refresh_token` grant — never needs a `client_secret`.
 */

/**
 * `true` when this host authenticates via the **bundled** Revv GitHub App
 * rather than a classic OAuth App. Pro edition on github.com uses the bundled
 * GitHub App; the bundled OSS/GHE paths use a classic OAuth App.
 *
 * This only governs which *bundled* client_id to pick. A user-added GHE host
 * brings its own client_id (see {@link clientIdForHost}) and may itself be a
 * GitHub App — detect that from the id with {@link clientIdIsGitHubApp}, not
 * from this predicate.
 */
export function usesGitHubApp(host: string): boolean {
  return serverEnv.edition === "pro" && isPublicGitHub(host);
}

/**
 * `true` when a client_id belongs to a GitHub App (prefix `Iv…`) rather than a
 * classic OAuth App (prefix `Ov…`). Drives the one device-flow difference: a
 * GitHub App's permissions are fixed at registration/install, so its
 * device-code request sends **no** `scope`; an OAuth App requests scopes at
 * login. Works for both bundled and user-supplied (BYO GHE) client IDs.
 */
export function clientIdIsGitHubApp(clientId: string): boolean {
  return clientId.startsWith("Iv");
}

export class MissingGitHubClientIdError extends Error {
  readonly code = "missing_github_client_id";

  constructor(
    readonly host: string,
    message: string,
  ) {
    super(message);
    this.name = "MissingGitHubClientIdError";
  }
}

export class InvalidGitHubClientIdError extends Error {
  readonly code = "invalid_github_client_id";

  constructor(
    readonly host: string,
    message: string,
  ) {
    super(message);
    this.name = "InvalidGitHubClientIdError";
  }
}

/**
 * github.com always resolves to Revv's bundled registration, checked BEFORE
 * `customClientId`: a `customClientId` is the id a user registered on their
 * own GHE instance and must never be applied to github.com. A stale GHE id
 * left in settings after switching back to a github.com account (the switch
 * updates only the host) would otherwise be POSTed to github.com's
 * device-code endpoint, which 404s. `savedClientIdForHost` (in `@revv/shared`)
 * applies the same rule to the saved ID.
 *
 * Throws a clear error when github.com lacks `GITHUB_CLIENT_ID_PUBLIC`, or when
 * a GHE host has no client ID at all, so the user gets a diagnosable message
 * instead of GitHub's opaque "invalid client".
 */
export function clientIdForHost(host: string, customClientId?: string | null): string {
  if (usesGitHubApp(host)) return serverEnv.githubAppClientId;
  if (isPublicGitHub(host)) {
    if (!serverEnv.githubClientIdPublic) {
      throw new MissingGitHubClientIdError(
        host,
        "Public GitHub sign-in requires GITHUB_CLIENT_ID_PUBLIC to be set. " +
          "Register an OAuth App on github.com and add GITHUB_CLIENT_ID_PUBLIC=<id> to your .env file.",
      );
    }
    return serverEnv.githubClientIdPublic;
  }
  const custom = customClientId?.trim();
  if (custom) {
    if (!isLikelyGitHubClientId(custom)) {
      throw new InvalidGitHubClientIdError(
        host,
        `The GitHub App or OAuth App client ID for ${host} is not valid. ${GITHUB_CLIENT_ID_HINT}`,
      );
    }
    return custom;
  }
  if (serverEnv.githubClientId) return serverEnv.githubClientId;
  throw new MissingGitHubClientIdError(
    host,
    `Signing in to ${host} requires a GitHub App or OAuth App client ID. ` +
      "Add one during onboarding (GitHub Enterprise → client ID), or set GITHUB_CLIENT_ID for a fixed deployment.",
  );
}

/**
 * The client_id to sign in to (or refresh a token on) `host`: an explicit
 * `override` (a deep link's or onboarding's transient input), else the one
 * saved for that host, else the bundled/env one.
 */
export function resolveClientId(
  host: string,
  saved: { readonly githubHost: string; readonly githubClientId: string },
  override?: string,
): string {
  return clientIdForHost(host, override?.trim() || savedClientIdForHost(host, saved));
}
