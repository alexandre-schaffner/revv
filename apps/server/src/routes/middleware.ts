import type { ApiErrorBody } from "@revv/shared";
import { Cause, Effect, Exit } from "effect";
import { Elysia, type ElysiaCustomStatusResponse, status } from "elysia";
import { GitHubAuthError, type HttpErrorStatus, httpErrorOf } from "../domain/errors";
import { logError } from "../logger";
import { AppRuntime, type AppServices } from "../runtime";
import { GitHubAccounts } from "../services/github/accounts";
import { SettingsService } from "../services/Settings";

const unauthorized = () =>
  status(401, { error: "Unauthorized", code: "UNAUTHORIZED" } satisfies ApiErrorBody);

const BEARER = /^Bearer\s+(\S+)$/i;

/** The local user behind a session token, or null for none, an expired one, or a DB failure. */
export async function sessionUserId(token: string | undefined): Promise<string | null> {
  if (!token) return null;
  const exit = await AppRuntime.runPromiseExit(
    Effect.flatMap(GitHubAccounts, (accounts) => accounts.sessionUser(token)),
  );
  if (Exit.isSuccess(exit)) return exit.value;
  logError("auth", "session lookup failed:", Cause.pretty(exit.cause));
  return null;
}

function bearerToken(headers: Headers): string | undefined {
  return BEARER.exec(headers.get("authorization") ?? "")?.[1];
}

/** Derives the signed-in `userId`; answers 401 without one. */
export const withAuth = new Elysia({ name: "with-auth" }).derive({ as: "scoped" }, async (ctx) => {
  const userId = await sessionUserId(bearerToken(ctx.request.headers));
  if (userId === null) return unauthorized();
  return { userId };
});

function queryHost(query: Record<string, unknown>): string | undefined {
  const host = query.host;
  if (typeof host !== "string") return undefined;
  const trimmed = host.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** The GitHub account a request acts as: the one on `?host=`, else the settings host's. */
export const requestAccount = (userId: string, query: Record<string, unknown>) =>
  Effect.gen(function* () {
    const host =
      queryHost(query) ?? (yield* Effect.flatMap(SettingsService, (s) => s.githubHost()));
    return yield* Effect.flatMap(GitHubAccounts, (accounts) =>
      accounts.accountForUser(userId, host),
    );
  });

/**
 * Derives `userId` and the request's GitHub `account` (see `requestAccount`).
 *
 * It resolves the session itself instead of chaining `.use(withAuth)`:
 * Elysia deduplicates named plugins, and when `withAuth` is deduped its
 * derived `userId` does not reach a sibling `derive`.
 */
export const withAccount = new Elysia({ name: "with-account" }).derive(
  { as: "scoped" },
  async (ctx) => {
    const userId = await sessionUserId(bearerToken(ctx.request.headers));
    if (userId === null) return unauthorized();
    const exit = await AppRuntime.runPromiseExit(
      requestAccount(userId, ctx.query as Record<string, unknown>),
    );
    if (Exit.isSuccess(exit)) return { userId, account: exit.value };
    const error = Cause.squash(exit.cause);
    if (error instanceof GitHubAuthError) return errorResponse(error);
    logError(
      "withAccount",
      "account resolution failed:",
      error instanceof Error ? error.message : String(error),
    );
    return unauthorized();
  },
);

/** A refused request, typed so Eden knows every error status and its body. */
export type ApiErrorResponse = ElysiaCustomStatusResponse<
  HttpErrorStatus,
  ApiErrorBody,
  HttpErrorStatus
>;

/** Answer a request with `error`'s HTTP meaning (see `httpErrorOf`). */
export function errorResponse(error: unknown): ApiErrorResponse {
  const { status: code, code: errorCode, message, details } = httpErrorOf(error);
  if (code >= 500) logError("route", `${errorCode}:`, message);
  return status(code, { ...details, error: message, code: errorCode } satisfies ApiErrorBody);
}

/**
 * Run a route's work and answer with its value, or with the HTTP meaning of
 * whatever it failed with. Takes the work as an Effect on the app runtime, or
 * as an async function for handlers that still await promises of their own.
 */
export function runRoute<A, E>(
  work: Effect.Effect<A, E, AppServices>,
): Promise<A | ApiErrorResponse>;
export function runRoute<A>(work: () => Promise<A>): Promise<A | ApiErrorResponse>;
export async function runRoute<A, E>(
  work: Effect.Effect<A, E, AppServices> | (() => Promise<A>),
): Promise<A | ApiErrorResponse> {
  if (Effect.isEffect(work)) {
    const exit = await AppRuntime.runPromiseExit(work);
    return Exit.isSuccess(exit) ? exit.value : errorResponse(Cause.squash(exit.cause));
  }
  try {
    return await work();
  } catch (e) {
    return errorResponse(e);
  }
}
