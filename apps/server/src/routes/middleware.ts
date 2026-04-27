import { Cause, Option } from "effect";
import { Elysia, status } from "elysia";
import { auth } from "../auth";
import {
  AiNotConfiguredError,
  GitHubAuthError,
  GitHubNetworkError,
  GitHubNotFoundError,
  GitHubRateLimitError,
  isReviewError,
  NotFoundError,
  SyncError,
} from "../domain/errors";

// ── Auth middleware ───────────────────────────────────────────────────────────

/**
 * Elysia `.derive()` plugin that extracts the session from request headers.
 * Short-circuits with 401 if no valid session is found; otherwise injects
 * `session` into typed context for downstream handlers.
 */
export const withAuth = new Elysia({ name: "with-auth" }).derive(
  { as: "scoped" },
  async (ctx) => {
    const session = await auth.api.getSession({ headers: ctx.request.headers });
    if (!session) {
      return status(401, { error: "Unauthorized" });
    }
    return { session };
  },
);

// ── Effect error unwrapping ─────────────────────────────────────────────────

const FIBER_FAILURE_CAUSE = Symbol.for("effect/Runtime/FiberFailure/Cause");

/**
 * Extract the original domain error from an Effect FiberFailure.
 * `Effect.runPromise` wraps failures in a FiberFailure — we use
 * `Cause.failureOption` to extract the underlying tagged error.
 */
export function unwrapEffectError(e: unknown): unknown {
  if (e !== null && typeof e === "object" && FIBER_FAILURE_CAUSE in e) {
    const cause = (e as Record<symbol, unknown>)[FIBER_FAILURE_CAUSE];
    const opt = Cause.failureOption(cause as Cause.Cause<unknown>);
    if (Option.isSome(opt)) {
      return opt.value;
    }
  }
  return e;
}

// ── Error mapping ─────────────────────────────────────────────────────────────

/**
 * Maps tagged Effect domain errors to HTTP responses.
 * Unwraps FiberFailure first, then checks instanceof.
 * Sets `ctx.set.status` and returns the error body, or rethrows for unknown errors.
 */
export function handleAppError(
  raw: unknown,
  ctx: { set: { status?: number | string } },
): { error: string } | never {
  const e = unwrapEffectError(raw);

  if (e instanceof NotFoundError) {
    ctx.set.status = 404;
    return { error: "Not found" };
  }

  if (e instanceof GitHubAuthError) {
    ctx.set.status = 401;
    return { error: "GitHub token expired or invalid" };
  }

  if (e instanceof GitHubNotFoundError) {
    ctx.set.status = 404;
    return { error: "Not found on GitHub" };
  }

  if (e instanceof AiNotConfiguredError) {
    ctx.set.status = 400;
    return {
      error: "AI CLI agent not configured — install opencode or claude",
    };
  }

  if (isReviewError(e)) {
    if (e.code === "NOT_FOUND") {
      ctx.set.status = 404;
      return { error: e.message };
    }
    ctx.set.status = 500;
    return { error: e.message };
  }

  if (e instanceof SyncError) {
    ctx.set.status = 502;
    return { error: e.message };
  }

  if (e instanceof GitHubNetworkError) {
    ctx.set.status = 502;
    return { error: `GitHub API error: ${String(e.cause)}` };
  }

  if (e instanceof GitHubRateLimitError) {
    ctx.set.status = 429;
    return {
      error: `GitHub rate limit exceeded, resets at ${e.resetAt.toISOString()}`,
    };
  }

  throw raw;
}

// ── Shared response helpers ─────────────────────────────────────────────────

/** Build a JSON Response with the given body and status code. */
export function jsonResponse(
  body: Record<string, unknown>,
  statusCode: number,
): Response {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Map an error (potentially wrapped in a FiberFailure) to a JSON Response.
 * Used by SSE endpoints that return raw Response objects instead of using
 * Elysia's `ctx.set.status` convention.
 */
export function mapErrorToSSEResponse(raw: unknown): Response {
  const e = unwrapEffectError(raw);

  if (e instanceof AiNotConfiguredError) {
    return jsonResponse(
      {
        code: "NOT_CONFIGURED",
        message: "AI CLI agent not configured — install opencode or claude",
      },
      400,
    );
  }
  if (e instanceof NotFoundError) {
    return jsonResponse(
      { code: "NOT_FOUND", message: `${e.resource} not found` },
      404,
    );
  }
  if (e instanceof GitHubAuthError) {
    return jsonResponse(
      { code: "GITHUB_AUTH_ERROR", message: "GitHub token expired or invalid" },
      401,
    );
  }
  if (e instanceof GitHubRateLimitError) {
    return jsonResponse(
      { code: "GITHUB_RATE_LIMITED", message: "GitHub API rate limited" },
      429,
    );
  }
  if (isReviewError(e)) {
    return jsonResponse({ code: "REVIEW_ERROR", message: e.message }, 500);
  }

  const message = e instanceof Error ? e.message : "Internal server error";
  return jsonResponse({ code: "INTERNAL_ERROR", message }, 500);
}

/**
 * Wrap a ReadableStream<string> of text chunks into an SSE-formatted
 * ReadableStream<Uint8Array>. Each chunk becomes a `data: <json>\n\n` frame,
 * followed by `data: [DONE]\n\n` on completion. Errors are emitted as
 * `event: error\ndata: <json>\n\n`.
 */
export function textStreamToSSE(
  textStream: ReadableStream<string>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = textStream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(value)}\n\n`),
          );
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (err) {
        const errMsg = JSON.stringify({
          code: "GENERATION_ERROR",
          message: err instanceof Error ? err.message : "Unknown error",
        });
        controller.enqueue(encoder.encode(`event: error\ndata: ${errMsg}\n\n`));
        controller.close();
      }
    },
  });
}
