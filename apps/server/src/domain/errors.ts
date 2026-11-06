import type { ApiErrorCode, ProposedCommit } from "@revv/shared";
import { Data } from "effect";

export class ProfilingError extends Data.TaggedError("ProfilingError")<{
  readonly cause: unknown;
}> {}

// GitHub API errors
export class GitHubRateLimitError extends Data.TaggedError("GitHubRateLimitError")<{
  readonly resetAt: Date;
  readonly retryAfter?: number;
  readonly kind?: "primary" | "secondary";
  readonly resource?: string;
}> {}

export class GitHubAuthError extends Data.TaggedError("GitHubAuthError")<{
  readonly message: string;
}> {}

/**
 * Transport-level failure: DNS, TLS, connection reset, request timeout, a
 * 5xx/408 from GitHub, or GraphQL's "Something went wrong while executing
 * your query" (GitHub's own failure, sent as a 200). **Retryable** — `retryTransient` in `services/github/transport.ts`
 * only retries this class, so nothing else may be mapped to it.
 */
export class GitHubNetworkError extends Data.TaggedError("GitHubNetworkError")<{
  readonly cause: unknown;
}> {}

/**
 * GitHub understood the request and rejected it: a 4xx that isn't
 * 401/403/404/429, or a GraphQL response carrying an `errors` array (other
 * than GitHub's own failure, above).
 * **Not retryable** — replaying it produces the same rejection, so retrying
 * only burns the backoff budget (2s + 4s + 8s per call) and stalls the
 * sequential sync loops.
 *
 * `cause` is a human-readable string (status + response body when available)
 * so callers can sniff GitHub's error text; see `isExistingPendingReviewError`.
 */
export class GitHubApiError extends Data.TaggedError("GitHubApiError")<{
  readonly status: number;
  readonly cause: unknown;
}> {}

export class GitHubAccessDeniedError extends Data.TaggedError("GitHubAccessDeniedError")<{
  readonly resource: string;
  readonly message: string;
}> {}

export class GitHubNotFoundError extends Data.TaggedError("GitHubNotFoundError")<{
  readonly resource: string;
  readonly id: string;
}> {}

/**
 * An add-repo lookup 404'd. GitHub answers 404 both for a repo that doesn't
 * exist and for one the token can't see — and a GitHub App token can't see
 * any repo the app isn't installed on — so this carries the diagnosis the
 * user needs: what's missing and, when known, the page that fixes it.
 */
export class RepoNotAccessibleError extends Data.TaggedError("RepoNotAccessibleError")<{
  readonly message: string;
  readonly detail: string;
  readonly action: { readonly label: string; readonly url: string } | null;
}> {}

export type GitHubError =
  | GitHubRateLimitError
  | GitHubAuthError
  | GitHubAccessDeniedError
  | GitHubNetworkError
  | GitHubApiError
  | GitHubNotFoundError;

/** GitHub couldn't be reached or is rate-limiting: try later, or serve what's cached. */
export function isGitHubUnreachable(e: unknown): e is GitHubNetworkError | GitHubRateLimitError {
  return e instanceof GitHubNetworkError || e instanceof GitHubRateLimitError;
}

// General errors
export class NotFoundError extends Data.TaggedError("NotFoundError")<{
  readonly resource: string;
  readonly id: string;
}> {}

export class ValidationError extends Data.TaggedError("ValidationError")<{
  readonly message: string;
  readonly field?: string;
}> {}

export class ExternalIntegrationError extends Data.TaggedError("ExternalIntegrationError")<{
  readonly message: string;
  readonly code:
    | "INVALID_CREDENTIAL"
    | "INVALID_PROJECT"
    | "PR_NOT_FOUND"
    | "INSTALL_FAILED"
    | "NOT_CONNECTED"
    | "INTERNAL";
  readonly cause?: unknown;
}> {}

// AI errors

/** `auth`: the agent isn't signed in, or Revv can't read its login. */
export type AgentFailureKind = "auth" | "other";

export class AiGenerationError extends Data.TaggedError("AiGenerationError")<{
  readonly cause: unknown;
  readonly message?: string;
  readonly kind?: AgentFailureKind;
}> {}

// biome-ignore lint/complexity/noBannedTypes: Effect TaggedError pattern requires {}
export class AiNotConfiguredError extends Data.TaggedError("AiNotConfiguredError")<{}> {}

/**
 * Why a TypeSafe System One (Jev) call produced no answer.
 *
 *   'unconfigured' — no API key in the keyring or `REVV_JEV_API_KEY`
 *   'disabled'     — the master switch or this hook's toggle is off
 *   'timeout'      — the call exceeded the caller's budget
 *   'rate_limited' — a 429 (the SDK doesn't retry those; see `JevServiceLive`)
 *   'transport'    — any other HTTP/connection failure, auth included
 *   'malformed'    — a 2xx whose body didn't match the expected answer shape
 *
 * `'unconfigured'`/`'disabled'` short-circuit with zero latency. Every call
 * site collapses all six to `null` and degrades to pre-Jev behaviour.
 */
export type JevUnavailableReason =
  | "unconfigured"
  | "disabled"
  | "timeout"
  | "rate_limited"
  | "transport"
  | "malformed";

export class JevUnavailable extends Data.TaggedError("JevUnavailable")<{
  readonly reason: JevUnavailableReason;
  readonly message?: string;
  /** Server's `Retry-After`, on `rate_limited` only, when it sent one. */
  readonly retryAfterMs?: number;
  readonly cause?: unknown;
}> {}

export type AiError = AiGenerationError | AiNotConfiguredError;

/** The caller may see the resource but not do this to it; `message` says why. */
export class ForbiddenError extends Data.TaggedError("ForbiddenError")<{
  readonly message: string;
}> {}

export class SyncError extends Data.TaggedError("SyncError")<{
  readonly message: string;
  readonly threadId?: string;
  readonly cause?: unknown;
}> {}

// Clone errors
export class CloneError extends Data.TaggedError("CloneError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class CloneNotReadyError extends Data.TaggedError("CloneNotReadyError")<{
  readonly repoId: string;
}> {}

export class CloneInProgressError extends Data.TaggedError("CloneInProgressError")<{
  readonly repoId: string;
}> {}

/**
 * Why Revv won't carry out a stack merge or rebase as asked; nothing was
 * merged or pushed.
 *
 *   stale           — a layer got new commits since the user looked.
 *   busy            — another merge run or rebase holds the stack, or the run
 *                     isn't in a state the ask applies to.
 *   replay-conflict — a layer doesn't replay cleanly; `files` says where.
 *   lease-lost      — a layer moved while Revv rebased; the leased push was refused.
 *   invalid         — the ask can't be met as the stack stands.
 *   failed          — git or the push failed.
 */
export type StackRejection =
  | { readonly reason: "stale" }
  | { readonly reason: "busy" }
  | { readonly reason: "replay-conflict"; readonly files: readonly string[] }
  | { readonly reason: "lease-lost" }
  | { readonly reason: "invalid" }
  | { readonly reason: "failed" };

/** A stack merge or rebase refused; `message` is the user's to read. */
export class StackRejectedError extends Data.TaggedError("StackRejectedError")<{
  readonly message: string;
  readonly rejection: StackRejection;
}> {}

/** Another flow is already pushing to `branch` (see `BranchPushLock`). */
export class ConcurrentPushError extends Data.TaggedError("ConcurrentPushError")<{
  readonly branch: string;
  readonly heldBy: "chat-push" | "base-sync" | "stack-rebase";
}> {}

/** What holds a PR's agent workspace (see `PrWorkspace`). */
export type WorkspaceHolder = "chat-turn" | "push" | "branch-edit";

/** Someone else holds the PR's agent workspace. */
export class WorkspaceBusyError extends Data.TaggedError("WorkspaceBusyError")<{
  readonly prId: string;
  readonly heldBy: WorkspaceHolder;
}> {}

// Pushing the chat agent's commits

export class DirtyWorktreeError extends Data.TaggedError("DirtyWorktreeError")<{
  readonly message: string;
}> {}

export class NoChangesError extends Data.TaggedError("NoChangesError")<{
  readonly prId: string;
}> {}

export class NoChatSessionError extends Data.TaggedError("NoChatSessionError")<{
  readonly prId: string;
}> {}

/**
 * A chat turn refused by its plan gate: a plan still awaits a decision, or the
 * plan the turn approves doesn't exist. Not in the HTTP table: the chat route
 * answers it with a stream refusal (`PLAN_PENDING` / `PLAN_NOT_FOUND`).
 */
export class PlanGateError extends Data.TaggedError("PlanGateError")<{
  readonly reason: "pending" | "not-found";
  readonly planId: string;
}> {}

/** Rewriting the agent's commits hit a conflict; the branch was put back as it was. */
export class AgentBranchConflictError extends Data.TaggedError("AgentBranchConflictError")<{
  readonly message: string;
}> {}

export class GitOperationError extends Data.TaggedError("GitOperationError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class PushRejectedError extends Data.TaggedError("PushRejectedError")<{
  readonly message: string;
}> {}

export class InvalidBranchNameError extends Data.TaggedError("InvalidBranchNameError")<{
  readonly message: string;
}> {}

/**
 * Why bringing a PR up to date with its base was refused:
 *   busy        — another push or base sync holds the PR.
 *   stale       — the PR head moved since the user looked.
 *   invalid     — the ask can't be met as the PR stands (closed, a fork,
 *                 unpushed agent commits a rebase would strand).
 *   unavailable — the clone or the history isn't there to work with.
 *   failed      — git failed.
 */
export type BaseConflictsRejection = "busy" | "stale" | "invalid" | "unavailable" | "failed";

/** A base-conflict resolve refused before the agent ran; `message` is the user's to read. */
export class BaseConflictsRejectedError extends Data.TaggedError("BaseConflictsRejectedError")<{
  readonly message: string;
  readonly reason: BaseConflictsRejection;
}> {}

/**
 * A caller pinned the head it wants reviewed (`startJob`'s `expectedHeadSha`)
 * and GitHub serves a different one — typically a push GitHub hasn't caught
 * up with yet. Nothing was cancelled or started.
 */
export class HeadShaMismatchError extends Data.TaggedError("HeadShaMismatchError")<{
  readonly expectedHeadSha: string;
  readonly githubHeadSha: string;
}> {}

/**
 * Raised when the PR head SHA has advanced but the worktree has unpushed
 * agent commits on top of the OLD head. Callers must discard or rebase
 * those commits before advancing the worktree.
 */
export class WorktreeBlockedByUnpushedCommits extends Data.TaggedError(
  "WorktreeBlockedByUnpushedCommits",
)<{
  readonly worktreePath: string;
  readonly branchName: string;
  readonly oldHeadSha: string;
  readonly newHeadSha: string;
  readonly commits: readonly ProposedCommit[];
}> {}

// ── Project Recap errors ───────────────────────────────────────────────────

/**
 * Raised when a recap row can't be found by id. Used by the manual
 * regenerate / detail endpoints to return 404 cleanly.
 */
export class RecapNotFoundError extends Data.TaggedError("RecapNotFoundError")<{
  readonly recapId: string;
}> {}

// Database errors
export class DbError extends Data.TaggedError("DbError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

// ── Remote walkthrough cache errors ────────────────────────────────────────
//
// `BlobStore*` errors describe failures at the storage-backend layer
// (GCS/S3/etc.). `Cache*` errors describe failures at the snapshot-level
// service that sits on top. The orchestrator treats every cache error as
// "miss + fall back to running the agent" — no error escapes to the user
// modulo settings-page health checks.

/**
 * The configured blob store is unreachable, misconfigured, or rejected
 * the request (network error, bucket 404, IAM 403). Surfaced from
 * `BlobStore` ops and bubbled up by `RemoteWalkthroughCache` as
 * `CacheUnavailable`.
 */
export class BlobStoreUnavailable extends Data.TaggedError("BlobStoreUnavailable")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * The blob exists but its metadata or body is unusable (missing
 * `schemaVersion`, `contentSha256` mismatch, gunzip failure). Cache hit
 * is downgraded to a miss; no row mutation.
 */
export class BlobCorrupt extends Data.TaggedError("BlobCorrupt")<{
  readonly key: string;
  readonly reason: string;
}> {}

/**
 * `RemoteWalkthroughCache` operation hit an unreachable backend. The
 * orchestrator treats this as "cache miss" and runs the agent.
 */
export class CacheUnavailable extends Data.TaggedError("CacheUnavailable")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * Failure while building the gzipped payload during `push`. Pure
 * marshalling error — never blocks job completion (push is fire-and-
 * forget; the fiber logs and continues).
 */
export class CacheSerialization extends Data.TaggedError("CacheSerialization")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * `WalkthroughSnapshotImporter.import` rejected the candidate snapshot
 * (validation gate failed, transaction couldn't land). Caller (the
 * orchestrator) falls back to running the agent.
 */
export class ImportError extends Data.TaggedError("ImportError")<{
  readonly walkthroughId: string;
  readonly reason: string;
  readonly cause?: unknown;
}> {}

// ── SSH cache-signing errors ────────────────────────────────────────────────

/** `ssh-keygen` binary is absent from PATH or the configured path. */
export class SshKeygenMissing extends Data.TaggedError("SshKeygenMissing")<{
  readonly message: string;
}> {}

/**
 * The local machine cannot sign right now — key not found, auto-detect
 * failed, or ssh-keygen returned an unexpected error. Push fails loudly
 * (fire-and-forget contract unchanged); the walkthrough still completes.
 */
export class SshSigningUnavailable extends Data.TaggedError("SshSigningUnavailable")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Signature verification failed — tampered message, wrong key, wrong namespace. */
export class SshSignatureInvalid extends Data.TaggedError("SshSignatureInvalid")<{
  readonly message: string;
}> {}

/** Public-key fetch from `https://<host>/<login>.keys` failed. */
export class SshKeysFetchFailed extends Data.TaggedError("SshKeysFetchFailed")<{
  readonly host: string;
  readonly login: string;
  readonly cause?: unknown;
}> {}

// ── HTTP meaning ────────────────────────────────────────────────────────────
//
// Every error above answers an HTTP request the same way wherever it
// surfaces: a REST route, a stream refused before it starts, or the external
// agent's MCP route. Adding an error class means adding its row here.

export type HttpErrorStatus = 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 502 | 503;

export interface HttpError {
  readonly status: HttpErrorStatus;
  readonly code: ApiErrorCode;
  readonly message: string;
  /** Extra body fields the client reads for this code. */
  readonly details?: Readonly<Record<string, unknown>>;
}

type AppError =
  | ProfilingError
  | GitHubRateLimitError
  | GitHubAuthError
  | GitHubNetworkError
  | GitHubApiError
  | GitHubAccessDeniedError
  | GitHubNotFoundError
  | RepoNotAccessibleError
  | NotFoundError
  | ValidationError
  | ExternalIntegrationError
  | AiGenerationError
  | AiNotConfiguredError
  | JevUnavailable
  | ForbiddenError
  | SyncError
  | CloneError
  | CloneNotReadyError
  | CloneInProgressError
  | StackRejectedError
  | ConcurrentPushError
  | WorkspaceBusyError
  | DirtyWorktreeError
  | NoChangesError
  | NoChatSessionError
  | AgentBranchConflictError
  | GitOperationError
  | PushRejectedError
  | InvalidBranchNameError
  | BaseConflictsRejectedError
  | HeadShaMismatchError
  | WorktreeBlockedByUnpushedCommits
  | RecapNotFoundError
  | DbError
  | BlobStoreUnavailable
  | BlobCorrupt
  | CacheUnavailable
  | CacheSerialization
  | ImportError
  | SshKeygenMissing
  | SshSigningUnavailable
  | SshSignatureInvalid
  | SshKeysFetchFailed;

const http = (
  status: HttpErrorStatus,
  code: ApiErrorCode,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): HttpError => (details ? { status, code, message, details } : { status, code, message });

const notFoundMessage = (resource: string): string =>
  `${resource.charAt(0).toUpperCase()}${resource.slice(1)} not found`;

const internal = (message: string): HttpError => http(500, "INTERNAL_ERROR", message);

const STACK_REJECTION_HTTP = {
  stale: [409, "STALE"],
  busy: [409, "BUSY"],
  "replay-conflict": [409, "REPLAY_CONFLICT"],
  "lease-lost": [409, "STALE"],
  invalid: [400, "INVALID"],
  failed: [422, "FAILED"],
} as const satisfies Record<StackRejection["reason"], readonly [HttpErrorStatus, ApiErrorCode]>;

const BASE_CONFLICTS_REJECTION_HTTP = {
  busy: [409, "BUSY"],
  stale: [409, "STALE"],
  invalid: [422, "INVALID"],
  unavailable: [503, "UNAVAILABLE"],
  failed: [500, "FAILED"],
} as const satisfies Record<BaseConflictsRejection, readonly [HttpErrorStatus, ApiErrorCode]>;

const EXTERNAL_INTEGRATION_HTTP = {
  INVALID_CREDENTIAL: [403, "FORBIDDEN"],
  INVALID_PROJECT: [404, "NOT_FOUND"],
  PR_NOT_FOUND: [404, "NOT_FOUND"],
  NOT_CONNECTED: [409, "NOT_CONNECTED"],
  INSTALL_FAILED: [400, "FAILED"],
  INTERNAL: [500, "INTERNAL_ERROR"],
} as const satisfies Record<
  ExternalIntegrationError["code"],
  readonly [HttpErrorStatus, ApiErrorCode]
>;

const HTTP_ERRORS: {
  readonly [Tag in AppError["_tag"]]: (e: Extract<AppError, { _tag: Tag }>) => HttpError;
} = {
  NotFoundError: (e) => http(404, "NOT_FOUND", notFoundMessage(e.resource)),
  RecapNotFoundError: () => http(404, "NOT_FOUND", notFoundMessage("recap")),
  ValidationError: (e) => http(400, "INVALID", e.message),
  ForbiddenError: (e) => http(403, "FORBIDDEN", e.message),
  GitHubAuthError: () => http(401, "GITHUB_AUTH_ERROR", "GitHub token expired or invalid"),
  GitHubAccessDeniedError: (e) => http(403, "FORBIDDEN", e.message),
  GitHubNotFoundError: () => http(404, "NOT_FOUND", "Not found on GitHub"),
  RepoNotAccessibleError: (e) =>
    http(404, "NOT_FOUND", e.message, {
      detail: e.detail,
      ...(e.action ? { action: e.action } : {}),
    }),
  GitHubRateLimitError: (e) =>
    http(
      429,
      "GITHUB_RATE_LIMITED",
      `GitHub rate limit exceeded, resets at ${e.resetAt.toISOString()}`,
    ),
  GitHubNetworkError: (e) => http(502, "GITHUB_ERROR", `GitHub API error: ${String(e.cause)}`),
  // GitHub rejected the request on its merits: pass its 4xx through. A 401,
  // 403 or 404 never gets here; each has its own class.
  GitHubApiError: (e) =>
    http(
      e.status >= 400 && e.status < 500 ? (e.status as HttpErrorStatus) : 502,
      "GITHUB_ERROR",
      `GitHub API error: ${String(e.cause)}`,
    ),
  SyncError: (e) => http(502, "GITHUB_ERROR", e.message),
  AiNotConfiguredError: () =>
    http(
      400,
      "NOT_CONFIGURED",
      "The selected AI agent can't be launched — install it or pick another in Settings",
    ),
  AiGenerationError: (e) =>
    http(
      500,
      e.kind === "auth" ? "AGENT_AUTH_REQUIRED" : "GENERATION_ERROR",
      e.message ?? `Generation failed: ${String(e.cause)}`,
    ),
  JevUnavailable: (e) =>
    http(503, "UNAVAILABLE", e.message ?? `TypeSafe is unavailable (${e.reason})`),
  ExternalIntegrationError: (e) => {
    const [status, code] = EXTERNAL_INTEGRATION_HTTP[e.code];
    return http(status, code, e.message);
  },
  CloneNotReadyError: () => http(409, "UNAVAILABLE", "Repository clone is not ready yet"),
  CloneInProgressError: () => http(409, "BUSY", "Repository clone is already in progress"),
  CloneError: (e) => http(502, "FAILED", e.message),
  StackRejectedError: (e) => {
    const [status, code] = STACK_REJECTION_HTTP[e.rejection.reason];
    return http(
      status,
      code,
      e.message,
      e.rejection.reason === "replay-conflict" ? { files: e.rejection.files } : undefined,
    );
  },
  BaseConflictsRejectedError: (e) => {
    const [status, code] = BASE_CONFLICTS_REJECTION_HTTP[e.reason];
    return http(status, code, e.message);
  },
  HeadShaMismatchError: (e) =>
    http(
      409,
      "STALE",
      `GitHub reports head ${e.githubHeadSha.slice(0, 7)}, not the requested ${e.expectedHeadSha.slice(0, 7)}`,
    ),
  WorktreeBlockedByUnpushedCommits: (e) =>
    http(409, "WORKTREE_BLOCKED", "PR head advanced but worktree has unpushed agent commits", {
      worktreePath: e.worktreePath,
      branchName: e.branchName,
      oldHeadSha: e.oldHeadSha,
      newHeadSha: e.newHeadSha,
      commits: e.commits,
    }),
  ConcurrentPushError: (e) =>
    http(
      409,
      "CONCURRENT_PUSH",
      e.heldBy === "chat-push"
        ? `A push of the agent's commits to ${e.branch} is already running`
        : e.heldBy === "base-sync"
          ? `Revv is already bringing ${e.branch} up to date`
          : `Revv is rebasing the stack ${e.branch} belongs to`,
    ),
  WorkspaceBusyError: (e) =>
    e.heldBy === "chat-turn"
      ? http(409, "CHAT_STREAMING", "Wait for the chat agent to finish")
      : e.heldBy === "push"
        ? http(409, "CONCURRENT_PUSH", "A push of the agent's commits is already running")
        : http(409, "BUSY", "Revv is still rewriting the agent's commits"),
  DirtyWorktreeError: (e) => http(409, "DIRTY_WORKTREE", e.message),
  NoChangesError: () => http(422, "NO_CHANGES", "No agent commits to push"),
  NoChatSessionError: () =>
    http(404, "NO_CHAT_SESSION", "No chat session for this PR — start a chat first"),
  AgentBranchConflictError: (e) => http(409, "REPLAY_CONFLICT", e.message),
  InvalidBranchNameError: (e) => http(400, "INVALID_BRANCH_NAME", e.message),
  PushRejectedError: (e) => http(502, "PUSH_REJECTED", e.message),
  GitOperationError: (e) => http(500, "FAILED", e.message),
  DbError: (e) => internal(e.message),
  ProfilingError: (e) => internal(String(e.cause)),
  BlobStoreUnavailable: (e) => internal(e.message),
  BlobCorrupt: (e) => internal(e.reason),
  CacheUnavailable: (e) => internal(e.message),
  CacheSerialization: (e) => internal(e.message),
  ImportError: (e) => internal(e.reason),
  SshKeygenMissing: (e) => internal(e.message),
  SshSigningUnavailable: (e) => internal(e.message),
  SshSignatureInvalid: (e) => internal(e.message),
  SshKeysFetchFailed: (e) => internal(`Couldn't fetch ${e.login}'s keys from ${e.host}`),
};

export function isAppError(e: unknown): e is AppError {
  return (
    typeof e === "object" &&
    e !== null &&
    "_tag" in e &&
    typeof e._tag === "string" &&
    Object.hasOwn(HTTP_ERRORS, e._tag)
  );
}

/** How `e` answers an HTTP request. Anything that isn't a domain error is a 500. */
export function httpErrorOf(e: unknown): HttpError {
  if (isAppError(e)) {
    const toHttp = HTTP_ERRORS[e._tag] as (error: AppError) => HttpError;
    return toHttp(e);
  }
  return internal(e instanceof Error ? e.message : "Internal server error");
}
