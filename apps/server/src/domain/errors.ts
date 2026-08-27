import { Data } from "effect";

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
 * Transport-level failure: DNS, TLS, connection reset, request timeout, or a
 * 5xx/408 from GitHub. **Retryable** — `retryTransient` in `github-rest.ts`
 * only retries this class, so nothing else may be mapped to it.
 */
export class GitHubNetworkError extends Data.TaggedError("GitHubNetworkError")<{
  readonly cause: unknown;
}> {}

/**
 * GitHub understood the request and rejected it: a 4xx that isn't
 * 401/403/404/429, or a GraphQL response carrying an `errors` array.
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

export type GitHubError =
  | GitHubRateLimitError
  | GitHubAuthError
  | GitHubAccessDeniedError
  | GitHubNetworkError
  | GitHubApiError
  | GitHubNotFoundError;

// General errors
export class NotFoundError extends Data.TaggedError("NotFoundError")<{
  readonly resource: string;
  readonly id: string;
}> {}

export class ValidationError extends Data.TaggedError("ValidationError")<{
  readonly message: string;
  readonly field?: string;
}> {}

// AI errors
export class AiGenerationError extends Data.TaggedError("AiGenerationError")<{
  readonly cause: unknown;
  readonly message?: string;
}> {}

// biome-ignore lint/complexity/noBannedTypes: Effect TaggedError pattern requires {}
export class AiNotConfiguredError extends Data.TaggedError("AiNotConfiguredError")<{}> {}

export class OpencodeNotSelectedError extends Data.TaggedError("OpencodeNotSelectedError")<{
  readonly selectedAgent: string;
}> {}

// biome-ignore lint/complexity/noBannedTypes: Effect TaggedError pattern requires {}
export class OpencodeUnhealthyError extends Data.TaggedError("OpencodeUnhealthyError")<{}> {}

export type AiError =
  | AiGenerationError
  | AiNotConfiguredError
  | OpencodeNotSelectedError
  | OpencodeUnhealthyError;

export class ReviewError extends Data.TaggedError("ReviewError")<{
  readonly message: string;
  readonly code?: string;
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
  readonly commits: ReadonlyArray<{
    sha: string;
    shortSha: string;
    subject: string;
    committedAt: string;
    files: string[];
  }>;
}> {}

// ── Project Recap errors ───────────────────────────────────────────────────

/**
 * Raised when a recap row can't be found by id. Used by the manual
 * regenerate / detail endpoints to return 404 cleanly.
 */
export class RecapNotFoundError extends Data.TaggedError("RecapNotFoundError")<{
  readonly recapId: string;
}> {}

/**
 * Raised by the recap MCP tool surface when an out-of-order or
 * structurally-invalid call lands (e.g. `complete_recap` before `set_lede`,
 * or `add_pr_entry` with a pr_id not in the source bundle). The agent
 * receives this as a structured error result and can recover by issuing
 * the right call.
 */
export class RecapPreconditionError extends Data.TaggedError("RecapPreconditionError")<{
  readonly recapId: string;
  readonly reason: string;
}> {}

/**
 * Raised when a recap row exceeds `RECAP_MAX_RESUME_ATTEMPTS` across
 * server restarts. The orchestrator flips the row to `'error'` and stops
 * relaunching it; this error type is the audit-log marker.
 */
export class RecapBudgetExceededError extends Data.TaggedError("RecapBudgetExceededError")<{
  readonly recapId: string;
  readonly attempts: number;
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

export type RecapError = RecapNotFoundError | RecapPreconditionError | RecapBudgetExceededError;

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

/**
 * Type guard for ReviewError.
 * Checks both instanceof (for directly thrown errors) and _tag (defensive for
 * serialized/deserialized errors crossing async boundaries, e.g. Effect channels).
 */
export function isReviewError(e: unknown): e is ReviewError {
  return (
    e instanceof ReviewError ||
    (e !== null &&
      typeof e === "object" &&
      "_tag" in e &&
      (e as { _tag: unknown })._tag === "ReviewError")
  );
}
