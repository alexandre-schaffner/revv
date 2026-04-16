import { Context, Effect, Layer, Schedule } from 'effect';
import type { PullRequest, Repository } from '@rev/shared';
import {
	GitHubAuthError,
	GitHubNetworkError,
	GitHubNotFoundError,
	GitHubRateLimitError,
	type GitHubError,
} from '../domain/errors';

const GITHUB_API = 'https://api.github.com';

const retrySchedule = Schedule.intersect(
	Schedule.exponential('2 seconds'),
	Schedule.recurs(3)
);

/** Parse "owner/repo" into parts, failing with GitHubNotFoundError if malformed. */
function parseRepoFullName(
	fullName: string
): Effect.Effect<{ owner: string; repo: string }, GitHubNotFoundError> {
	const [owner, repo] = fullName.split('/');
	if (!owner || !repo) {
		return Effect.fail(new GitHubNotFoundError({ resource: 'repo', id: fullName }));
	}
	return Effect.succeed({ owner, repo });
}

/** Pass through known GitHub errors; wrap unknown ones in GitHubNetworkError. */
function toGitHubError(e: unknown): GitHubError {
	if (
		e instanceof GitHubAuthError ||
		e instanceof GitHubRateLimitError ||
		e instanceof GitHubNotFoundError ||
		e instanceof GitHubNetworkError
	) {
		return e;
	}
	return new GitHubNetworkError({ cause: e });
}

/** Build the standard headers for GitHub API requests. */
function githubHeaders(token: string): Record<string, string> {
	return {
		Authorization: `Bearer ${token}`,
		Accept: 'application/vnd.github.v3+json',
		'X-GitHub-Api-Version': '2022-11-28',
	};
}

/** Assert a fetch response is successful, throwing the appropriate domain error on failure. */
function assertGitHubOk(res: Response, path: string): void {
	if (res.status === 401) {
		throw new GitHubAuthError({ message: 'Invalid or expired GitHub token' });
	}
	if (res.status === 403) {
		const resetHeader = res.headers.get('X-RateLimit-Reset');
		const resetAt = resetHeader ? new Date(Number(resetHeader) * 1000) : new Date();
		throw new GitHubRateLimitError({ resetAt });
	}
	if (res.status === 404) {
		throw new GitHubNotFoundError({ resource: path, id: path });
	}
	if (!res.ok) {
		throw new GitHubNetworkError({ cause: `HTTP ${res.status}` });
	}
}

function githubFetch(
	path: string,
	token: string
): Effect.Effect<unknown, GitHubError> {
	return Effect.tryPromise({
		try: async () => {
			const res = await fetch(`${GITHUB_API}${path}`, {
				headers: githubHeaders(token),
			});
			assertGitHubOk(res, path);
			return res.json();
		},
		catch: toGitHubError,
	});
}

/** Parse GitHub Link header to find the URL for rel="next". */
function parseLinkNext(linkHeader: string | null): string | null {
	if (!linkHeader) return null;
	const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
	return match?.[1] ?? null;
}

/**
 * Fetch a paginated GitHub API list endpoint, following Link rel="next" headers
 * up to `maxPages` pages. Returns the concatenated array of all results.
 */
function githubFetchPaginated(
	path: string,
	token: string,
	maxPages: number = 3
): Effect.Effect<unknown[], GitHubError> {
	return Effect.tryPromise({
		try: async () => {
			const results: unknown[] = [];
			let url: string | null = `${GITHUB_API}${path}`;

			for (let page = 0; page < maxPages && url; page++) {
				const res = await fetch(url, {
					headers: githubHeaders(token),
				});
				assertGitHubOk(res, path);

				const data = await res.json();
				if (Array.isArray(data)) {
					results.push(...data);
				}

				url = parseLinkNext(res.headers.get('Link'));
			}

			return results;
		},
		catch: toGitHubError,
	});
}

function mapPr(raw: Record<string, unknown>, repositoryId: string): PullRequest {
	const user = raw['user'] as Record<string, unknown>;
	const head = raw['head'] as Record<string, unknown>;
	const base = raw['base'] as Record<string, unknown>;
	return {
		id: `${repositoryId}:${raw['number']}`,
		externalId: raw['number'] as number,
		repositoryId,
		title: raw['title'] as string,
		body: (raw['body'] as string | null) ?? null,
		authorLogin: user['login'] as string,
		authorAvatarUrl: (user['avatar_url'] as string | null) ?? null,
		status:
			raw['state'] === 'closed'
				? raw['merged_at']
					? 'merged'
					: 'closed'
				: 'open',
		reviewStatus: 'pending',
		sourceBranch: head['ref'] as string,
		targetBranch: base['ref'] as string,
		url: raw['html_url'] as string,
		additions: (raw['additions'] as number | undefined) ?? 0,
		deletions: (raw['deletions'] as number | undefined) ?? 0,
		changedFiles: (raw['changed_files'] as number | undefined) ?? 0,
		headSha: head['sha'] as string,
		baseSha: base['sha'] as string,
		createdAt: raw['created_at'] as string,
		updatedAt: raw['updated_at'] as string,
		fetchedAt: new Date().toISOString(),
	};
}

function mapRepo(raw: Record<string, unknown>): Repository {
	const owner = raw['owner'] as Record<string, unknown>;
	return {
		id: String(raw['id']),
		provider: 'github',
		owner: owner['login'] as string,
		name: raw['name'] as string,
		fullName: raw['full_name'] as string,
		defaultBranch: (raw['default_branch'] as string | undefined) ?? 'main',
		avatarUrl: (owner['avatar_url'] as string | null) ?? null,
		addedAt: new Date().toISOString(),
		cloneStatus: 'pending',
		clonePath: null,
		cloneError: null,
	};
}

export interface PrMeta {
	readonly baseSha: string;
	readonly headSha: string;
}

export interface PrFileMeta {
	readonly filename: string;
	readonly previousFilename: string | null;
	readonly status: string;
	readonly additions: number;
	readonly deletions: number;
	readonly patch: string | null;
}

export class GitHubService extends Context.Tag('GitHubService')<
	GitHubService,
	{
		readonly listPrs: (
			repoFullName: string,
			repositoryId: string,
			token: string
		) => Effect.Effect<PullRequest[], GitHubError>;
		readonly getPr: (
			repoFullName: string,
			prNumber: number,
			token: string
		) => Effect.Effect<PullRequest, GitHubError>;
		readonly getRepo: (
			fullName: string,
			token: string
		) => Effect.Effect<Repository, GitHubError>;
		readonly listUserRepos: (
			token: string
		) => Effect.Effect<Repository[], GitHubError>;
		readonly getPrMeta: (
			repoFullName: string,
			prNumber: number,
			token: string
		) => Effect.Effect<PrMeta, GitHubError>;
		readonly getPrFiles: (
			repoFullName: string,
			prNumber: number,
			token: string
		) => Effect.Effect<PrFileMeta[], GitHubError>;
		readonly getFileContent: (
			repoFullName: string,
			path: string,
			ref: string,
			token: string
		) => Effect.Effect<string, GitHubError>;
	}
>() {}

export const GitHubServiceLive = Layer.succeed(GitHubService, {
	listPrs: (repoFullName, repositoryId, token) =>
		Effect.gen(function* () {
			const { owner, repo } = yield* parseRepoFullName(repoFullName);
			const data = yield* githubFetch(
				`/repos/${owner}/${repo}/pulls?state=open&per_page=100`,
				token
			);
			return (data as Record<string, unknown>[]).map((pr) => mapPr(pr, repositoryId));
		}).pipe(Effect.retry(retrySchedule)),

	getPr: (repoFullName, prNumber, token) =>
		Effect.gen(function* () {
			const { owner, repo } = yield* parseRepoFullName(repoFullName);
			const data = yield* githubFetch(
				`/repos/${owner}/${repo}/pulls/${prNumber}`,
				token
			);
			return mapPr(data as Record<string, unknown>, `${owner}/${repo}`);
		}).pipe(Effect.retry(retrySchedule)),

	getRepo: (fullName, token) =>
		Effect.gen(function* () {
			const { owner, repo } = yield* parseRepoFullName(fullName);
			const data = yield* githubFetch(`/repos/${owner}/${repo}`, token);
			return mapRepo(data as Record<string, unknown>);
		}).pipe(Effect.retry(retrySchedule)),

	listUserRepos: (token) =>
		Effect.gen(function* () {
			const data = yield* githubFetchPaginated(
				'/user/repos?affiliation=owner,collaborator,organization_member&sort=pushed&per_page=100',
				token,
				3
			);
			return (data as Record<string, unknown>[]).map((raw) => mapRepo(raw));
		}).pipe(Effect.retry(retrySchedule)),

	getPrMeta: (repoFullName, prNumber, token) =>
		Effect.gen(function* () {
			const { owner, repo } = yield* parseRepoFullName(repoFullName);
			const data = yield* githubFetch(
				`/repos/${owner}/${repo}/pulls/${prNumber}`,
				token
			);
			const raw = data as Record<string, unknown>;
			const base = raw['base'] as Record<string, unknown>;
			const head = raw['head'] as Record<string, unknown>;
			return { baseSha: base['sha'] as string, headSha: head['sha'] as string };
		}).pipe(Effect.retry(retrySchedule)),

	getPrFiles: (repoFullName, prNumber, token) =>
		Effect.gen(function* () {
			const { owner, repo } = yield* parseRepoFullName(repoFullName);
			const data = yield* githubFetch(
				`/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100`,
				token
			);
			return (data as Record<string, unknown>[]).map((f) => ({
				filename: f['filename'] as string,
				previousFilename: (f['previous_filename'] as string | undefined) ?? null,
				status: f['status'] as string,
				additions: (f['additions'] as number | undefined) ?? 0,
				deletions: (f['deletions'] as number | undefined) ?? 0,
				patch: (f['patch'] as string | undefined) ?? null,
			}));
		}).pipe(Effect.retry(retrySchedule)),

	getFileContent: (repoFullName, path, ref, token) =>
		Effect.gen(function* () {
			const { owner, repo } = yield* parseRepoFullName(repoFullName);
			const encodedPath = path.split('/').map(encodeURIComponent).join('/');
			const data = yield* githubFetch(
				`/repos/${owner}/${repo}/contents/${encodedPath}?ref=${ref}`,
				token
			);
			const obj = data as Record<string, unknown>;
			if (obj['encoding'] === 'base64' && typeof obj['content'] === 'string') {
				return Buffer.from(obj['content'] as string, 'base64').toString('utf-8');
			}
			// Binary or unsupported encoding
			return '';
		}).pipe(Effect.retry(retrySchedule)),
});
