import { Data } from "effect";

// GitHub API errors
export class GitHubRateLimitError extends Data.TaggedError("GitHubRateLimitError")<{
  readonly resetAt: Date;
}> {}

export class GitHubAuthError extends Data.TaggedError("GitHubAuthError")<{
  readonly message: string;
}> {}

export class GitHubNetworkError extends Data.TaggedError("GitHubNetworkError")<{
  readonly cause: unknown;
}> {}

export class GitHubNotFoundError extends Data.TaggedError("GitHubNotFoundError")<{
  readonly resource: string;
  readonly id: string;
}> {}

export type GitHubError =
  | GitHubRateLimitError
  | GitHubAuthError
  | GitHubNetworkError
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

export type AiError = AiGenerationError | AiNotConfiguredError;

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

export type AppError =
  | GitHubError
  | AiError
  | NotFoundError
  | ValidationError
  | ReviewError
  | SyncError
  | CloneError
  | CloneNotReadyError
  | CloneInProgressError
  | WorktreeBlockedByUnpushedCommits;

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
