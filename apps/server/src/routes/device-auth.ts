import { normalizeGithubHost } from "@revv/shared";
import { Effect } from "effect";
import { Elysia, t } from "elysia";
import { GitHubApiError, NotFoundError } from "../domain/errors";
import { logError } from "../logger";
import { forgetAccount } from "../services/clone/forget";
import { GitHubAccounts } from "../services/github/accounts";
import {
  exchangeDeviceCode,
  issuedTokens,
  resolveClientId,
  startDeviceFlow,
} from "../services/github/oauth";
import { SettingsService } from "../services/Settings";
import { runRoute, withAuth } from "./middleware";

/**
 * The host a device-flow request targets (the request's, else the settings
 * host) and the client ids to try there, in order. A typed id is the only
 * one. Otherwise the client the caller's account on that host was issued to
 * comes first (re-signing an account in is keyed by the account, not by the
 * machine's host), then the one saved for the host: an app replaced in
 * settings takes over once GitHub refuses the old one.
 */
const signInTarget = (body: {
  readonly host?: string;
  readonly client_id?: string;
  readonly session_token?: string;
}) =>
  Effect.gen(function* () {
    const settings = yield* SettingsService;
    const accounts = yield* GitHubAccounts;
    const saved = yield* settings.getSettings();
    const host = normalizeGithubHost(body.host ?? "") || (yield* settings.githubHost());
    const typed = body.client_id?.trim();
    if (typed) return { host, clientIds: [yield* resolveClientId(host, saved, typed)] as const };
    const callerId = body.session_token ? yield* accounts.sessionUser(body.session_token) : null;
    const issued = callerId === null ? null : yield* accounts.issuedClientIdOn(callerId, host);
    if (issued === null) return { host, clientIds: [yield* resolveClientId(host, saved)] as const };
    const first = yield* resolveClientId(host, saved, issued);
    const fallback = yield* Effect.orElseSucceed(resolveClientId(host, saved), () => first);
    return {
      host,
      clientIds: fallback === first ? ([first] as const) : ([first, fallback] as const),
    };
  });

// Device-flow sign-in: no session yet.
const deviceFlowRoutes = new Elysia()
  .post(
    "/api/auth/device/init",
    ({ body }) =>
      runRoute(
        Effect.gen(function* () {
          const target = yield* signInTarget(body ?? {});
          const { clientId, code } = yield* startDeviceFlow(target.host, target.clientIds);
          return {
            host: target.host,
            client_id: clientId,
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
        t.Object({
          host: t.Optional(t.String()),
          client_id: t.Optional(t.String()),
          session_token: t.Optional(t.String()),
        }),
      ),
    },
  )
  .post(
    "/api/auth/device/poll",
    ({ body }) =>
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
          const target = { host: normalizeGithubHost(body.host), clientId: body.client_id };
          const exchanged = yield* exchangeDeviceCode(
            target.host,
            target.clientId,
            body.device_code,
          );

          const { data } = exchanged;

          if (data.access_token) {
            const { sessionToken } = yield* accounts
              .signIn({
                host: target.host,
                clientId: target.clientId,
                tokens: issuedTokens(data, new Date()),
                linkToUserId,
              })
              .pipe(
                Effect.tapError((e) =>
                  Effect.sync(() => logError("device-auth", "sign-in failed:", e)),
                ),
              );
            return sessionToken === null
              ? { status: "linked" as const }
              : { status: "success" as const, token: sessionToken };
          }

          // GitHub's verdicts on the device code are answers, like `pending`:
          // only a failure to ask is a refusal.
          if (data.error === "authorization_pending") return { status: "pending" as const };
          if (data.error === "slow_down") {
            return { status: "slow_down" as const, interval: data.interval ?? 10 };
          }
          if (data.error === "expired_token") return { status: "expired" as const };
          if (data.error === "access_denied") return { status: "denied" as const };

          logError("device-auth", "unexpected GitHub token response:", data);
          return yield* Effect.fail(
            new GitHubApiError({
              status: exchanged.status,
              cause: data.error_description ?? data.error ?? "Unknown error from GitHub",
            }),
          );
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
    (ctx) => runRoute(forgetAccount(ctx.userId, ctx.body.host).pipe(Effect.as({ ok: true }))),
    { body: t.Object({ host: t.String() }) },
  );

export const deviceAuthRoutes = new Elysia().use(deviceFlowRoutes).use(sessionRoutes);
