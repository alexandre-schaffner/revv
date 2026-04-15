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
export class AiRateLimitError extends Data.TaggedError('AiRateLimitError')<{
	readonly retryAfter: number;
}> {}

export class AiAuthError extends Data.TaggedError('AiAuthError')<{
	readonly message: string;
}> {}

export class AiGenerationError extends Data.TaggedError('AiGenerationError')<{
	readonly cause: unknown;
}> {}

export class AiNotConfiguredError extends Data.TaggedError('AiNotConfiguredError')<{}> {}

export type AiError = AiRateLimitError | AiAuthError | AiGenerationError | AiNotConfiguredError;

export class ReviewError extends Data.TaggedError('ReviewError')<{
	readonly message: string;
	readonly code?: string;
}> {}

export type AppError = GitHubError | AiError | NotFoundError | ValidationError | ReviewError;
