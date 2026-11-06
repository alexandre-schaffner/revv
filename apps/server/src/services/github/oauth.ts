/**
 * GitHub's OAuth endpoints for the device-code sign-in and the refresh grant,
 * plus the viewer reads a fresh sign-in needs. The device flow — including
 * its refresh grant — takes a `client_id` only, never a `client_secret`.
 */
import { Effect } from "effect";
import type { GitHubError } from "../../domain/errors";
import { clientIdIsGitHubApp } from "../../github-oauth";
import { oauthPost } from "./transport";

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

export type DeviceCodeAnswer =
  | { readonly ok: true; readonly code: DeviceCode }
  | {
      readonly ok: false;
      readonly status: number;
      readonly statusText: string;
      readonly text: string;
    };

export const requestDeviceCode = (
  host: string,
  clientId: string,
): Effect.Effect<DeviceCodeAnswer, GitHubError> =>
  oauthPost(host, "/login/device/code", {
    client_id: clientId,
    ...(clientIdIsGitHubApp(clientId) ? {} : { scope: DEVICE_FLOW_SCOPE }),
  }).pipe(
    Effect.map(
      (res): DeviceCodeAnswer =>
        res.status >= 200 && res.status < 300
          ? { ok: true, code: JSON.parse(res.text) as DeviceCode }
          : { ok: false, ...res },
    ),
  );

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
