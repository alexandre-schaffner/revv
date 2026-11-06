// ── API errors ──────────────────────────────────────────────────────────────
//
// A refused request answers with one of these codes. The server maps each of
// its errors to a code and an HTTP status in one table
// (`apps/server/src/domain/errors.ts`); the client branches on the code,
// never on the message.

export type ApiErrorCode =
  | "UNAUTHORIZED"
  | "INVALID"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "NOT_CONFIGURED"
  | "NOT_CONNECTED"
  | "GITHUB_AUTH_ERROR"
  | "GITHUB_RATE_LIMITED"
  | "GITHUB_ERROR"
  | "BUSY"
  | "STALE"
  | "REPLAY_CONFLICT"
  | "UNAVAILABLE"
  | "FAILED"
  | "WORKTREE_BLOCKED"
  | "CONCURRENT_PUSH"
  | "CHAT_STREAMING"
  | "DIRTY_WORKTREE"
  | "NO_CHANGES"
  | "NO_CHAT_SESSION"
  | "INVALID_BRANCH_NAME"
  | "REF_EXISTS"
  | "PUSH_REJECTED"
  | "GENERATION_ERROR"
  | "INTERNAL_ERROR";

/** The JSON body of a refused REST request. */
export interface ApiErrorBody {
  readonly error: string;
  readonly code: ApiErrorCode;
  /**
   * Code-specific details: `detail`/`action` for a repository GitHub won't
   * show, `files` for `REPLAY_CONFLICT`, the blocked commits for
   * `WORKTREE_BLOCKED`.
   */
  readonly [detail: string]: unknown;
}
