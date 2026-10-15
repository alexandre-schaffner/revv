/**
 * The server's own wording for a failed Eden call (`handleAppError` answers
 * `{ error }`, Elysia's validator `{ message }`), else `fallback` with the
 * status. GitHub's refusals are only legible in that body: a bare "HTTP 405"
 * hides "Merge commits are not allowed on this repository."
 */
export function apiErrorMessage(
  error: { status: number; value?: unknown },
  fallback: string,
): string {
  const value = error.value as { error?: unknown; message?: unknown } | null | undefined;
  if (typeof value?.error === "string") return value.error;
  if (typeof value?.message === "string") return value.message;
  return `${fallback} (HTTP ${error.status})`;
}
