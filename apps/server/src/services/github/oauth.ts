/**
 * GitHub's OAuth endpoints for the device-code sign-in and the refresh grant,
 * and which client id each host signs in with.
 *
 * Revv targets github.com with a bundled public OAuth App (or, in Pro, a
 * bundled GitHub App), and any GitHub Enterprise host with a client ID the
 * user supplies during onboarding — no GHE host is baked in. The device flow
 * — including its refresh grant — takes a `client_id` only, never a
 * `client_secret`.
 */
import {
  clientIdKind,
  GITHUB_CLIENT_ID_HINT,
  isPublicGitHub,
  savedClientIdForHost,
} from "@revv/shared";
import { Effect } from "effect";
import { serverEnv } from "../../config";
import {
  GitHubApiError,
  type GitHubError,
  InvalidGitHubClientIdError,
  MissingGitHubClientIdError,
} from "../../domain/errors";
import { logError } from "../../logger";
import { oauthPost } from "./transport";

export type ClientIdError = MissingGitHubClientIdError | InvalidGitHubClientIdError;

/**
 * A GitHub App's permissions are fixed at registration/install, so its
 * device-code request sends no `scope`; an OAuth App requests scopes at login.
 */
export function clientIdIsGitHubApp(clientId: string): boolean {
  return clientIdKind(clientId) === "github-app";
}

/**
 * The client id to sign in to (or refresh a token on) `host` with.
 *
 * github.com always resolves to Revv's bundled registration (Pro: the bundled
 * GitHub App), checked BEFORE `customClientId`: a custom id is one a user
 * registered on their own GHE instance, and github.com's device-code
 * endpoint 404s on it. A GHE host takes `customClientId`, else
 * `GITHUB_CLIENT_ID` for a fixed deployment.
 */
export function clientIdForHost(
  host: string,
  customClientId?: string | null,
): Effect.Effect<string, ClientIdError> {
  if (isPublicGitHub(host)) {
    if (serverEnv.edition === "pro") return Effect.succeed(serverEnv.githubAppClientId);
    if (serverEnv.githubClientIdPublic) return Effect.succeed(serverEnv.githubClientIdPublic);
    return Effect.fail(
      new MissingGitHubClientIdError({
        host,
        message:
          "Public GitHub sign-in requires GITHUB_CLIENT_ID_PUBLIC to be set. " +
          "Register an OAuth App on github.com and add GITHUB_CLIENT_ID_PUBLIC=<id> to your .env file.",
      }),
    );
  }
  const custom = customClientId?.trim();
  if (custom) {
    return clientIdKind(custom) === null
      ? Effect.fail(
          new InvalidGitHubClientIdError({
            host,
            message: `The GitHub App or OAuth App client ID for ${host} is not valid. ${GITHUB_CLIENT_ID_HINT}`,
          }),
        )
      : Effect.succeed(custom);
  }
  if (serverEnv.githubClientId) return Effect.succeed(serverEnv.githubClientId);
  return Effect.fail(
    new MissingGitHubClientIdError({
      host,
      message:
        `Signing in to ${host} requires a GitHub App or OAuth App client ID. ` +
        "Add one during onboarding (GitHub Enterprise → client ID), or set GITHUB_CLIENT_ID for a fixed deployment.",
    }),
  );
}

/**
 * The client id a sign-in to `host` uses: an explicit `override` (a deep
 * link's or onboarding's transient input), else the one saved for that host,
 * else the bundled/env one.
 */
export function resolveClientId(
  host: string,
  saved: { readonly githubHost: string; readonly githubClientId: string },
  override?: string,
): Effect.Effect<string, ClientIdError> {
  return clientIdForHost(host, override?.trim() || savedClientIdForHost(host, saved));
}

/**
 * Classic OAuth App device-flow scope. A GitHub App's permissions are fixed at
 * registration/install, so its device-code request sends no scope.
 */
const DEVICE_FLOW_SCOPE = "repo read:org user:email";

/** The scope recorded on the account row for this client: null for a GitHub App. */
export function deviceFlowScopeFor(clientId: string): string | null {
  return clientIdIsGitHubApp(clientId) ? null : DEVICE_FLOW_SCOPE;
}

/** GitHub's token-endpoint answer, for both the device-code exchange and the refresh grant. */
export interface OAuthTokenResponse {
  readonly access_token?: string;
  /**
   * Present only when the app has "Expire user authorization tokens" enabled
   * (common on GitHub Enterprise): `access_token` then expires after
   * `expires_in` seconds and is renewable with this until
   * `refresh_token_expires_in` seconds elapse.
   */
  readonly refresh_token?: string;
  readonly expires_in?: number;
  readonly refresh_token_expires_in?: number;
  readonly error?: string;
  readonly error_description?: string;
  readonly interval?: number;
}

export interface IssuedTokens {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly accessTokenExpiresAt: Date | null;
  readonly refreshTokenExpiresAt: Date | null;
}

export function issuedTokens(data: OAuthTokenResponse, now: Date): IssuedTokens {
  return {
    accessToken: data.access_token ?? "",
    refreshToken: data.refresh_token ?? null,
    accessTokenExpiresAt: data.expires_in ? new Date(now.getTime() + data.expires_in * 1000) : null,
    refreshTokenExpiresAt: data.refresh_token_expires_in
      ? new Date(now.getTime() + data.refresh_token_expires_in * 1000)
      : null,
  };
}

export interface DeviceCode {
  readonly device_code: string;
  readonly user_code: string;
  readonly verification_uri: string;
  readonly expires_in: number;
  readonly interval: number;
}

/**
 * GitHub's answer to a device-code request for a client it doesn't know: 404
 * for an id registered elsewhere (github.com on a GHE id), 400/401 otherwise.
 */
const rejectsClient = (status: number) => status === 400 || status === 401 || status === 404;

function deviceFlowErrorMessage(
  host: string,
  res: { readonly status: number; readonly statusText: string; readonly text: string },
): string {
  let detail = res.text.trim();
  try {
    const parsed = JSON.parse(res.text) as { error?: string; error_description?: string };
    detail = parsed.error_description ?? parsed.error ?? detail;
  } catch {
    // Keep the raw text.
  }
  const suffix = detail ? `: ${detail.slice(0, 300)}` : "";
  return (
    `GitHub device flow failed for ${host} (${res.status} ${res.statusText}${suffix}). ` +
    "Check that the client ID belongs to this GitHub host and that Device Flow is enabled."
  );
}

/**
 * Start a device-flow sign-in on `host` with the first of `clientIds` GitHub
 * accepts, and say which one it was: the poll must use the same.
 */
export const startDeviceFlow = (
  host: string,
  clientIds: readonly [string, ...string[]],
): Effect.Effect<
  { readonly clientId: string; readonly code: DeviceCode },
  GitHubError | InvalidGitHubClientIdError
> =>
  Effect.gen(function* () {
    for (const clientId of clientIds) {
      const res = yield* oauthPost(host, "/login/device/code", {
        client_id: clientId,
        ...(clientIdIsGitHubApp(clientId) ? {} : { scope: DEVICE_FLOW_SCOPE }),
      });
      if (res.status >= 200 && res.status < 300) {
        return { clientId, code: JSON.parse(res.text) as DeviceCode };
      }
      logError(
        "device-auth",
        `GitHub device code request failed: ${res.status} ${res.statusText}`,
        res.text,
      );
      if (!rejectsClient(res.status)) {
        return yield* Effect.fail(
          new GitHubApiError({ status: res.status, cause: deviceFlowErrorMessage(host, res) }),
        );
      }
    }
    return yield* Effect.fail(
      new InvalidGitHubClientIdError({
        host,
        message: `GitHub rejected the client ID for ${host}. Check that it was copied from the GitHub App or OAuth App registered on that host.`,
      }),
    );
  });

const tokenRequest = (host: string, params: Record<string, string>) =>
  oauthPost(host, "/login/oauth/access_token", params).pipe(
    Effect.map((res) => ({
      status: res.status,
      data: (res.text ? JSON.parse(res.text) : {}) as OAuthTokenResponse,
    })),
  );

export const exchangeDeviceCode = (host: string, clientId: string, deviceCode: string) =>
  tokenRequest(host, {
    client_id: clientId,
    device_code: deviceCode,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  });

export const refreshGrant = (host: string, clientId: string, refreshToken: string) =>
  tokenRequest(host, {
    client_id: clientId,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
