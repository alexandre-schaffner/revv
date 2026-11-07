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
  | "GITHUB_AUTH_ERROR"
  // Signing in to the body's `host` needs a client id it doesn't have, or the
  // one it has isn't valid there.
  | "MISSING_GITHUB_CLIENT_ID"
  | "INVALID_GITHUB_CLIENT_ID"
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
  | "PUSH_REJECTED"
  | "PLAN_PENDING"
  | "PLAN_NOT_FOUND"
  | "ATTACHMENT_TOO_LARGE"
  | "ATTACHMENT_INVALID"
  | "GENERATION_ERROR"
  // The agent isn't signed in, or Revv can't read its login (Keychain). Also
  // the code of a walkthrough's `error` / `lifecycle:error` event for it.
  | "AGENT_AUTH_REQUIRED"
  | "INTERNAL_ERROR";

/** The JSON body of a refused REST request. */
export interface ApiErrorBody {
  readonly error: string;
  readonly code: ApiErrorCode;
  /**
   * Code-specific details: `detail`/`action` for a repository GitHub won't
   * show, `files` for `REPLAY_CONFLICT`, the blocked commits for
   * `WORKTREE_BLOCKED`, `planId` for `PLAN_PENDING` / `PLAN_NOT_FOUND`.
   */
  readonly [detail: string]: unknown;
}
