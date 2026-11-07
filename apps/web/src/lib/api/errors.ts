import { type ApiErrorCode, isApiErrorCode } from "@revv/shared";

/** A refused request: its status and its parsed body (Eden's `error`, or a raw fetch's). */
interface Refusal {
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
function bodyMessage(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  if (typeof body.error === "string" && body.error) return body.error;
  if (typeof body.message === "string" && body.message) return body.message;
  return undefined;
}

/**
 * The server refused a request, REST or stream. `message` is its wording,
 * else the caller's fallback with the status: GitHub's refusals are only
 * legible in that body, a bare "HTTP 405" hides "Merge commits are not
 * allowed on this repository."
 */
export class ApiError extends Error {
  override readonly name = "ApiError";
  readonly status: number;
  /** The error table's code; null for a refusal outside it (Elysia's validator, a proxy). */
  readonly code: ApiErrorCode | null;
  /** The refusal's JSON body, with any code-specific details (see `ApiErrorBody`). */
  readonly body: Readonly<Record<string, unknown>> | null;
  /** The server's own wording, when the body carries one. */
  readonly serverMessage: string | undefined;

  constructor(refusal: Refusal, fallback: string) {
    const serverMessage = bodyMessage(refusal.value);
    super(serverMessage ?? `${fallback} (HTTP ${String(refusal.status)})`);
    this.status = typeof refusal.status === "number" ? refusal.status : 0;
    this.body = isRecord(refusal.value) ? refusal.value : null;
    const code = this.body?.code;
    this.code = isApiErrorCode(code) ? code : null;
    this.serverMessage = serverMessage;
  }
}

type EdenResult = { readonly data: unknown; readonly error: Refusal | null };

/**
 * Await an Eden call and return its success body. A refusal throws
 * {@link ApiError}; a network failure throws the fetch's own error. Eden
 * itself only throws on the network, so a call that skips this treats every
 * 4xx/5xx as success.
 */
export async function call<R extends EdenResult>(
  request: Promise<R>,
  fallback: string,
): Promise<Extract<R, { error: null }>["data"]> {
  const { data, error } = await request;
  if (error) throw new ApiError(error, fallback);
  return data as Extract<R, { error: null }>["data"];
}

/** The refusal's code when `e` is an {@link ApiError}, else null. */
export function apiErrorCode(e: unknown): ApiErrorCode | null {
  return e instanceof ApiError ? e.code : null;
}
