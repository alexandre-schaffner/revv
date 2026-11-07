import type { ApiErrorCode } from "@revv/shared";

/** An Eden call's `error`: the refused status and its parsed body. */
interface EdenError {
  readonly status: unknown;
  readonly value?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The server's wording in a refused request's body (`ApiErrorBody.error`). */
export function bodyMessage(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  return typeof body.error === "string" && body.error ? body.error : undefined;
}

/**
 * The server's own wording for a refused request, else `fallback` with the
 * status. GitHub's refusals are only legible in that body: a bare "HTTP 405"
 * hides "Merge commits are not allowed on this repository."
 */
export function apiErrorMessage(error: EdenError, fallback: string): string {
  return bodyMessage(error.value) ?? `${fallback} (HTTP ${String(error.status)})`;
}

/** The server refused a request. `message` is its wording, else the caller's fallback with the status. */
export class ApiError extends Error {
  override readonly name = "ApiError";
  readonly status: number;
  /** The error table's code; null for a refusal that isn't the server's (a proxy). */
  readonly code: ApiErrorCode | null;
  /** The refusal's JSON body, with any code-specific details (see `ApiErrorBody`). */
  readonly body: Readonly<Record<string, unknown>> | null;
  /** The server's own wording, when the body carries one. */
  readonly serverMessage: string | undefined;

  constructor(error: EdenError, fallback: string) {
    super(apiErrorMessage(error, fallback));
    this.status = typeof error.status === "number" ? error.status : 0;
    this.body = isRecord(error.value) ? error.value : null;
    this.code = typeof this.body?.code === "string" ? (this.body.code as ApiErrorCode) : null;
    this.serverMessage = bodyMessage(error.value);
  }
}

type EdenResult = { readonly data: unknown; readonly error: EdenError | null };

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
