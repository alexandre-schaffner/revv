import type { ApiErrorBody } from "@revv/shared";
import { Cause, Effect, Exit } from "effect";
import { Elysia, type ElysiaCustomStatusResponse, status } from "elysia";
import { type HttpErrorStatus, httpErrorOf } from "../domain/errors";
import { logError } from "../logger";
import { AppRuntime, type AppServices } from "../runtime";
import { GitHubAccounts } from "../services/github/accounts";
import { SettingsService } from "../services/Settings";

const unauthorized = () =>
  status(401, { error: "Unauthorized", code: "UNAUTHORIZED" } satisfies ApiErrorBody);

const BEARER = /^Bearer\s+(\S+)$/i;

/**
 * The signed-in user behind a session token, or the refusal to answer with:
 * 401 for no session or an expired one, the fault's own status when the
 * lookup itself failed. A 401 tells the client its session is gone, so a
 * fault must never answer one.
 */
export async function authenticate(
  token: string | undefined,
): Promise<{ readonly userId: string } | ReturnType<typeof unauthorized> | ApiErrorResponse> {
  if (!token) return unauthorized();
  const exit = await AppRuntime.runPromiseExit(
    Effect.flatMap(GitHubAccounts, (accounts) => accounts.sessionUser(token)),
  );
  if (Exit.isFailure(exit)) return errorResponse(Cause.squash(exit.cause));
  return exit.value === null ? unauthorized() : { userId: exit.value };
}

function bearerToken(headers: Headers): string | undefined {
  return BEARER.exec(headers.get("authorization") ?? "")?.[1];
}

/** Derives the signed-in `userId` (see `authenticate`). */
export const withAuth = new Elysia({ name: "with-auth" }).derive({ as: "scoped" }, (ctx) =>
  authenticate(bearerToken(ctx.request.headers)),
);

/**
 * The GitHub account a request that names no repository acts as: the user's
 * account on the active host, which picks the default list view. A request
 * about a repository or pull request acts as the account that owns it
 * instead (`routes/ownership.ts`).
 */
export const activeAccount = (userId: string) =>
  Effect.gen(function* () {
    const host = yield* Effect.flatMap(SettingsService, (s) => s.githubHost());
    return yield* Effect.flatMap(GitHubAccounts, (accounts) =>
      accounts.accountForUser(userId, host),
    );
  });

/**
 * Derives `userId` and the request's `account` (see `activeAccount`).
 *
 * It resolves the session itself instead of chaining `.use(withAuth)`:
 * Elysia deduplicates named plugins, and when `withAuth` is deduped its
 * derived `userId` does not reach a sibling `derive`.
 */
export const withAccount = new Elysia({ name: "with-account" }).derive(
  { as: "scoped" },
  async (ctx) => {
    const auth = await authenticate(bearerToken(ctx.request.headers));
    if (!("userId" in auth)) return auth;
    const exit = await AppRuntime.runPromiseExit(activeAccount(auth.userId));
    if (Exit.isSuccess(exit)) return { userId: auth.userId, account: exit.value };
    return errorResponse(Cause.squash(exit.cause));
  },
);

/** A refused request, typed so Eden knows every error status and its body. */
export type ApiErrorResponse = ElysiaCustomStatusResponse<
  HttpErrorStatus,
  ApiErrorBody,
  HttpErrorStatus
>;

/** `error`'s HTTP status and refusal body (see `httpErrorOf`); logs a server fault. */
export function refusalOf(error: unknown): { status: HttpErrorStatus; body: ApiErrorBody } {
  const { status: code, code: errorCode, message, details } = httpErrorOf(error);
  if (code >= 500) logError("route", `${errorCode}:`, message);
  return { status: code, body: { ...details, error: message, code: errorCode } };
}

/** Answer a request with `error`'s HTTP meaning (see `httpErrorOf`). */
export function errorResponse(error: unknown): ApiErrorResponse {
  const refusal = refusalOf(error);
  return status(refusal.status, refusal.body);
}

/**
 * Elysia's own refusals, a body that fails its route schema or doesn't parse,
 * answered with the same body as every other refusal.
 */
export const requestRefusals = new Elysia({ name: "request-refusals" }).onError(
  { as: "global" },
  ({ code, error }) => {
    if (code === "VALIDATION") {
      const message = error.all[0]?.summary ?? error.valueError?.message ?? "Invalid request";
      return status(422, { error: message, code: "INVALID" } satisfies ApiErrorBody);
    }
    if (code === "PARSE") {
      return status(400, {
        error: "The request body isn't valid JSON",
        code: "INVALID",
      } satisfies ApiErrorBody);
    }
  },
);

/**
 * Run a route's work on the app runtime and answer with its value, or with
 * the HTTP meaning of whatever it failed with.
 */
export async function runRoute<A, E>(
  work: Effect.Effect<A, E, AppServices>,
): Promise<A | ApiErrorResponse> {
  const exit = await AppRuntime.runPromiseExit(work);
  return Exit.isSuccess(exit) ? exit.value : errorResponse(Cause.squash(exit.cause));
}
