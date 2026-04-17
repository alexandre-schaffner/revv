import { Data } from 'effect';

// GitHub API errors
export class GitHubRateLimitError extends Data.TaggedError('GitHubRateLimitError')<{
	readonly resetAt: Date;
}> {}

export class GitHubAuthError extends Data.TaggedError('GitHubAuthError')<{
	readonly message: string;
}> {}

export class GitHubNetworkError extends Data.TaggedError('GitHubNetworkError')<{
	readonly cause: unknown;
}> {}

export class GitHubNotFoundError extends Data.TaggedError('GitHubNotFoundError')<{
	readonly resource: string;
	readonly id: string;
}> {}

export type GitHubError =
	| GitHubRateLimitError
	| GitHubAuthError
	| GitHubNetworkError
	| GitHubNotFoundError;

// General errors
export class NotFoundError extends Data.TaggedError('NotFoundError')<{
	readonly resource: string;
	readonly id: string;
}> {}

export class ValidationError extends Data.TaggedError('ValidationError')<{
	readonly message: string;
	readonly field?: string;
}> {}

// AI errors
export class AiGenerationError extends Data.TaggedError('AiGenerationError')<{
	readonly cause: unknown;
}> {}

export class AiNotConfiguredError extends Data.TaggedError('AiNotConfiguredError')<{}> {}

export type AiError = AiGenerationError | AiNotConfiguredError;

export class ReviewError extends Data.TaggedError('ReviewError')<{
	readonly message: string;
	readonly code?: string;
}> {}

export class SyncError extends Data.TaggedError('SyncError')<{
	readonly message: string;
	readonly threadId?: string;
	readonly cause?: unknown;
}> {}

// Clone errors
export class CloneError extends Data.TaggedError('CloneError')<{
	readonly message: string;
	readonly cause?: unknown;
}> {}

export class CloneNotReadyError extends Data.TaggedError('CloneNotReadyError')<{
	readonly repoId: string;
}> {}

export type AppError =
	| GitHubError
	| AiError
	| NotFoundError
	| ValidationError
	| ReviewError
	| SyncError
	| CloneError
	| CloneNotReadyError;

/**
 * Type guard for ReviewError.
 * Checks both instanceof (for directly thrown errors) and _tag (defensive for
 * serialized/deserialized errors crossing async boundaries, e.g. Effect channels).
 */
export function isReviewError(e: unknown): e is ReviewError {
	return (
		e instanceof ReviewError ||
		(e !== null &&
			typeof e === 'object' &&
			'_tag' in e &&
			(e as { _tag: unknown })._tag === 'ReviewError')
	);
}
