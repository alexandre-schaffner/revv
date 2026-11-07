import { Effect } from "effect";
import { Elysia, t } from "elysia";
import { NotFoundError } from "../domain/errors";
import {
  InvalidGitHubClientIdError,
  MissingGitHubClientIdError,
  resolveClientId,
} from "../github-oauth";
import { logError } from "../logger";
import { GitHubAccounts } from "../services/github/accounts";
import { exchangeDeviceCode, issuedTokens, requestDeviceCode } from "../services/github/oauth";
import { SettingsService } from "../services/Settings";
import { runRoute, withAuth } from "./middleware";

type ClientIdError = MissingGitHubClientIdError | InvalidGitHubClientIdError;

type SignInTarget =
  | { readonly ok: true; readonly host: string; readonly clientId: string }
  | { readonly ok: false; readonly error: ClientIdError };

/**
 * The host and client_id a device-flow request targets: the request's own,
 * else the settings host and the client ID saved for it.
 */
const signInTarget = (
  hostOverride: string | undefined,
  clientIdOverride: string | undefined,
): Effect.Effect<SignInTarget, never, SettingsService> =>
  Effect.gen(function* () {
    const settings = yield* SettingsService;
    const saved = yield* settings.getSettings();
    const host = hostOverride?.trim() || (yield* settings.githubHost());
    try {
      return { ok: true, host, clientId: resolveClientId(host, saved, clientIdOverride) };
    } catch (e) {
      if (e instanceof MissingGitHubClientIdError || e instanceof InvalidGitHubClientIdError) {
        return { ok: false, error: e };
      }
      throw e;
    }
  });

function clientIdErrorBody(e: ClientIdError) {
  return { error: e.message, code: e.code, host: e.host };
}

function rejectedClientIdBody(host: string) {
  return {
    error: `GitHub rejected the client ID for ${host}. Check that it was copied from the GitHub App or OAuth App registered on that host.`,
    code: "invalid_github_client_id" as const,
    host,
  };
}

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

// Device-flow sign-in: no session yet.
const deviceFlowRoutes = new Elysia()
  .post(
    "/api/auth/device/init",
    ({ body, status }) =>
      runRoute(
        Effect.gen(function* () {
          const target = yield* signInTarget(body?.host, body?.client_id);
          if (!target.ok) return status(400, clientIdErrorBody(target.error));
          const answer = yield* requestDeviceCode(target.host, target.clientId);
          if (!answer.ok) {
            logError(
              "device-auth",
              `GitHub device code request failed: ${answer.status} ${answer.statusText}`,
              answer.text,
            );
            if (answer.status === 400 || answer.status === 401) {
              return status(400, rejectedClientIdBody(target.host));
            }
            return status(502, { error: deviceFlowErrorMessage(target.host, answer) });
          }
          const { code } = answer;
          return {
            host: target.host,
            client_id: target.clientId,
            device_code: code.device_code,
            user_code: code.user_code,
            verification_uri: code.verification_uri,
            expires_in: code.expires_in,
            interval: code.interval,
          };
        }),
      ),
    {
      body: t.Optional(
        t.Object({ host: t.Optional(t.String()), client_id: t.Optional(t.String()) }),
      ),
    },
  )
  .post(
    "/api/auth/device/poll",
    ({ body, status }) =>
      runRoute(
        Effect.gen(function* () {
          const accounts = yield* GitHubAccounts;
          // A signed-in caller (linking another host, or re-authenticating the
          // active account) sends its session token.
          const linkToUserId = body.session_token
            ? yield* accounts.sessionUser(body.session_token)
            : null;

          // The device code belongs to the client `/device/init` resolved, so
          // the poll uses exactly that host and client.
          const target = { host: body.host, clientId: body.client_id };
          const { data } = yield* exchangeDeviceCode(
            target.host,
            target.clientId,
            body.device_code,
          );

          if (data.access_token) {
            const signedIn = yield* accounts
              .signIn({
                host: target.host,
                clientId: target.clientId,
                tokens: issuedTokens(data, new Date()),
                linkToUserId,
              })
              .pipe(Effect.result);
            if (signedIn._tag === "Failure") {
              const e = signedIn.failure;
              logError("device-auth", "sign-in failed:", e);
              return status(500, {
                error: `${linkToUserId ? "Account link" : "Session creation"} failed: ${e.message}`,
              });
            }
            const { sessionToken } = signedIn.success;
            return sessionToken === null
              ? { status: "linked" as const }
              : { status: "success" as const, token: sessionToken };
          }

          if (data.error === "authorization_pending") return { status: "pending" as const };
          if (data.error === "slow_down") {
            return { status: "slow_down" as const, interval: data.interval ?? 10 };
          }
          if (data.error === "expired_token") return status(400, { error: "expired" });
          if (data.error === "access_denied") return status(400, { error: "access_denied" });

          logError("device-auth", "unexpected GitHub token response:", data);
          return status(400, { error: data.error ?? "Unknown error from GitHub" });
        }),
      ),
    {
      body: t.Object({
        device_code: t.String(),
        host: t.String({ minLength: 1 }),
        client_id: t.String({ minLength: 1 }),
        session_token: t.Optional(t.String()),
      }),
    },
  );

// Everything else needs a signed-in user. A switch mints a session for another
// local user, so only someone already signed in on this machine may ask.
const sessionRoutes = new Elysia()
  .use(withAuth)
  .get("/api/auth/local-accounts", () =>
    runRoute(Effect.flatMap(GitHubAccounts, (accounts) => accounts.localUsers)),
  )
  .post(
    "/api/auth/switch",
    ({ body }) =>
      runRoute(
        Effect.gen(function* () {
          const accounts = yield* GitHubAccounts;
          const token = yield* accounts.switchTo(body.userId);
          if (token === null) {
            return yield* Effect.fail(new NotFoundError({ resource: "user", id: body.userId }));
          }
          return { token };
        }),
      ),
    { body: t.Object({ userId: t.String({ minLength: 1 }) }) },
  )
  .get("/api/auth/accounts", (ctx) =>
    runRoute(Effect.flatMap(GitHubAccounts, (accounts) => accounts.connectedHosts(ctx.userId))),
  )
  .post(
    "/api/auth/accounts/disconnect",
    (ctx) =>
      runRoute(
        Effect.flatMap(GitHubAccounts, (accounts) =>
          accounts.disconnect(ctx.userId, ctx.body.host),
        ).pipe(Effect.as({ ok: true })),
      ),
    { body: t.Object({ host: t.String() }) },
  );

export const deviceAuthRoutes = new Elysia().use(deviceFlowRoutes).use(sessionRoutes);
