import type { ApiErrorBody, ApiErrorCode } from "@revv/shared";

/** A refused request: an Eden call's `error`, or a raw response's status and parsed body. */
export interface ApiError {
  readonly status: unknown;
  readonly value?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * The server's wording in a refused request's body: the error table's
 * `error`, else `message` (Elysia's validator, and a stream refused before it
 * opened).
 */
export function bodyMessage(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  if (typeof body.error === "string" && body.error) return body.error;
  if (typeof body.message === "string" && body.message) return body.message;
  return undefined;
}

/**
 * The server's own wording for a refused request, else `fallback` with the
 * status. GitHub's refusals are only legible in that body: a bare "HTTP 405"
 * hides "Merge commits are not allowed on this repository."
 */
export function apiErrorMessage(error: ApiError, fallback: string): string {
  return bodyMessage(error.value) ?? `${fallback} (HTTP ${String(error.status)})`;
}

export function apiErrorBody(error: ApiError): ApiErrorBody | null {
  const body = error.value;
  return isRecord(body) && typeof body.error === "string" && typeof body.code === "string"
    ? (body as ApiErrorBody)
    : null;
}

export function apiErrorCode(error: ApiError): ApiErrorCode | null {
  return apiErrorBody(error)?.code ?? null;
}
