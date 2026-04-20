import { Context, Effect, Layer, Schedule } from 'effect';
import type { PullRequest, Repository } from '@revv/shared';
import {
	GitHubAuthError,
	GitHubNetworkError,
	GitHubNotFoundError,
	GitHubRateLimitError,
	type GitHubError,
} from '../domain/errors';
import { GITHUB_API_BASE } from '../auth';
import { DbService } from './Db';
import { GitHubEtagCache, buildCacheKey } from './GitHubEtagCache';

const GITHUB_API = GITHUB_API_BASE;

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

/**
 * Fetch a single-page GitHub REST endpoint with conditional-request caching.
 *
 * On cache hit with unchanged server state, GitHub responds `304 Not Modified`
 * and we replay the stored body — zero bytes of real payload, zero rate-limit
 * cost. On `200`, we refresh the stored ETag + body for next time.
 *
 * Only use this for endpoints that return a single page. Paginated endpoints
 * (`listUserRepos`, `listReviewComments`) still call `githubFetchPaginated`
 * directly; per-page ETag caching can be added later.
 */
function conditionalFetch(
	path: string,
	token: string
): Effect.Effect<unknown, GitHubError, DbService | GitHubEtagCache> {
	return Effect.gen(function* () {
		const cache = yield* GitHubEtagCache;
		const cacheKey = buildCacheKey('GET', path);
		const cached = yield* cache.get(cacheKey);

		const result = yield* Effect.tryPromise({
			try: async () => {
				const headers: Record<string, string> = githubHeaders(token);
				if (cached) {
					headers['If-None-Match'] = cached.etag;
				}
				const res = await fetch(`${GITHUB_API}${path}`, { headers });

				if (res.status === 304 && cached) {
					// Server confirms our cached body is still fresh.
					return { kind: 'hit' as const, body: cached.body, bytes: 0 };
				}

				// For any other status code, fall through to normal error handling.
				assertGitHubOk(res, path);

				const bodyText = await res.text();
				const body = bodyText ? JSON.parse(bodyText) : null;
				const etag = res.headers.get('ETag');
				const lastModified = res.headers.get('Last-Modified');
				return {
					kind: 'miss' as const,
					body,
					bytes: bodyText.length,
					etag,
					lastModified,
				};
			},
			catch: toGitHubError,
		});

		if (result.kind === 'hit') {
			// Approximate bytes saved = size of the body we'd have downloaded.
			let saved = 0;
			try {
				saved = JSON.stringify(result.body).length;
			} catch {
				/* swallow — stats are best-effort */
			}
			cache.recordHit(saved);
			return result.body;
		}

		cache.recordMiss();
		if (result.etag) {
			yield* cache.put(cacheKey, result.etag, result.lastModified ?? null, result.body);
		}
		return result.body;
	});
}

function githubPost(
	path: string,
	token: string,
	body: Record<string, unknown>
): Effect.Effect<unknown, GitHubError> {
	return Effect.tryPromise({
		try: async () => {
			const res = await fetch(`${GITHUB_API}${path}`, {
				method: 'POST',
				headers: { ...githubHeaders(token), 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			});
			if (res.status === 422) {
				const text = await res.text().catch(() => '');
				throw new GitHubNetworkError({ cause: `422 Unprocessable Entity: ${text}` });
			}
			assertGitHubOk(res, path);
			return res.json();
		},
		catch: toGitHubError,
	});
}

/**
 * POST a GraphQL query/mutation. Throws on `errors[]` in the response body
 * even if the HTTP status is 200 (GitHub convention).
 */
function githubGraphql<T = unknown>(
	query: string,
	variables: Record<string, unknown>,
	token: string
): Effect.Effect<T, GitHubError> {
	return Effect.tryPromise({
		try: async () => {
			const res = await fetch(`${GITHUB_API}/graphql`, {
				method: 'POST',
				headers: { ...githubHeaders(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ query, variables }),
			});
			assertGitHubOk(res, '/graphql');
			const payload = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
			if (payload.errors && payload.errors.length > 0) {
				throw new GitHubNetworkError({
					cause: `GraphQL: ${payload.errors.map((e) => e.message).join('; ')}`,
				});
			}
			if (!payload.data) {
				throw new GitHubNetworkError({ cause: 'GraphQL: empty data field' });
			}
			return payload.data;
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
	const rawReviewers = raw['requested_reviewers'] as Array<Record<string, unknown>> | undefined;
	const requestedReviewers = (rawReviewers ?? []).map((r) => r['login'] as string);
	return {
		id: `${repositoryId}:${raw['number']}`,
		externalId: raw['number'] as number,
		repositoryId,
		title: raw['title'] as string,
		body: (raw['body'] as string | null) ?? null,
		authorLogin: user['login'] as string,
		authorAvatarUrl: (user['avatar_url'] as string | null) ?? null,
		requestedReviewers,
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

export interface PrCommit {
	readonly sha: string;
	readonly message: string;
	readonly authorLogin: string | null;
	readonly authorAvatarUrl: string | null;
	readonly date: string | null;
}

export class GitHubService extends Context.Tag('GitHubService')<
	GitHubService,
	{
		readonly listPrs: (
			repoFullName: string,
			repositoryId: string,
			token: string
		) => Effect.Effect<PullRequest[], GitHubError, DbService | GitHubEtagCache>;
		readonly getPr: (
			repoFullName: string,
			prNumber: number,
			token: string
		) => Effect.Effect<PullRequest, GitHubError, DbService | GitHubEtagCache>;
		readonly getRepo: (
			fullName: string,
			token: string
		) => Effect.Effect<Repository, GitHubError, DbService | GitHubEtagCache>;
		/**
		 * Like `getRepo`, but bypasses the ETag cache. Required for fields that
		 * rotate server-side without changing the endpoint's ETag — notably
		 * GitHub Enterprise signed `avatar_url`s, whose token expires but whose
		 * ETag stays the same. Hitting `getRepo` would replay the cached body
		 * with the now-dead token; this variant forces a 200 every time.
		 */
		readonly getRepoFresh: (
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
		) => Effect.Effect<PrMeta, GitHubError, DbService | GitHubEtagCache>;
		readonly getPrFiles: (
			repoFullName: string,
			prNumber: number,
			token: string
		) => Effect.Effect<PrFileMeta[], GitHubError, DbService | GitHubEtagCache>;
		readonly listPrCommits: (
			repoFullName: string,
			prNumber: number,
			token: string
		) => Effect.Effect<PrCommit[], GitHubError>;
		readonly getFileContent: (
			repoFullName: string,
			path: string,
			ref: string,
			token: string
		) => Effect.Effect<string, GitHubError>;
		readonly postReview: (
			repoFullName: string,
			prNumber: number,
			review: {
				readonly body: string;
				readonly event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
				readonly comments: ReadonlyArray<{
					readonly path: string;
					readonly body: string;
					readonly line: number;
					readonly side: 'LEFT' | 'RIGHT';
					readonly startLine?: number;
					readonly startSide?: 'LEFT' | 'RIGHT';
				}>;
			},
			token: string
		) => Effect.Effect<{ id: number; htmlUrl: string }, GitHubError>;
		readonly listReviewCommentsForReview: (
			repoFullName: string,
			prNumber: number,
			reviewId: number,
			token: string
		) => Effect.Effect<Array<{ id: number; path: string; line: number | null; originalLine: number | null; body: string }>, GitHubError>;
		readonly postReviewComment: (
			repoFullName: string,
			prNumber: number,
			comment: {
				readonly path: string;
				readonly body: string;
				readonly line: number;
				readonly side: 'LEFT' | 'RIGHT';
				readonly startLine?: number;
				readonly startSide?: 'LEFT' | 'RIGHT';
				readonly commitSha: string;
			},
			token: string
		) => Effect.Effect<{ id: number; htmlUrl: string; createdAt: string }, GitHubError>;
		readonly replyToComment: (
			repoFullName: string,
			prNumber: number,
			commentId: string | number,
			body: string,
			token: string
		) => Effect.Effect<{ id: number; htmlUrl: string; createdAt: string }, GitHubError>;
		readonly listReviewComments: (
			repoFullName: string,
			prNumber: number,
			since: string | null,
			token: string
		) => Effect.Effect<GhReviewComment[], GitHubError>;
		readonly listReviewThreads: (
			repoFullName: string,
			prNumber: number,
			token: string
		) => Effect.Effect<GhReviewThread[], GitHubError>;
		readonly resolveReviewThread: (
			threadNodeId: string,
			token: string
		) => Effect.Effect<void, GitHubError>;
		readonly unresolveReviewThread: (
			threadNodeId: string,
			token: string
		) => Effect.Effect<void, GitHubError>;
		readonly getAuthenticatedUser: (
			token: string
		) => Effect.Effect<
			{ login: string; id: number; avatarUrl: string | null },
			GitHubError,
			DbService | GitHubEtagCache
		>;
		/**
		 * Like `getAuthenticatedUser`, but bypasses the ETag cache. Required for
		 * the same reason as {@link getRepoFresh}: GitHub Enterprise signed
		 * `avatar_url`s rotate server-side without changing the endpoint's ETag,
		 * so a plain `getAuthenticatedUser` would replay the cached body with the
		 * now-dead token. This variant forces a 200 every time.
		 */
		readonly getAuthenticatedUserFresh: (
			token: string
		) => Effect.Effect<
			{ login: string; id: number; avatarUrl: string | null },
			GitHubError
		>;
	}
>() {}

export interface GhReviewComment {
	readonly id: number;
	readonly inReplyToId: number | null;
	readonly path: string;
	readonly line: number | null;
	readonly startLine: number | null;
	readonly side: 'LEFT' | 'RIGHT';
	readonly body: string;
	readonly authorLogin: string;
	readonly authorAvatarUrl: string | null;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly htmlUrl: string;
}

export interface GhReviewThread {
	readonly nodeId: string;
	readonly isResolved: boolean;
	readonly commentDatabaseIds: ReadonlyArray<number>;
}

export const GitHubServiceLive = Layer.succeed(GitHubService, {
	listPrs: (repoFullName, repositoryId, token) =>
		Effect.gen(function* () {
			const { owner, repo } = yield* parseRepoFullName(repoFullName);
			const data = yield* conditionalFetch(
				`/repos/${owner}/${repo}/pulls?state=open&per_page=100`,
				token
			);
			return (data as Record<string, unknown>[]).map((pr) => mapPr(pr, repositoryId));
		}).pipe(Effect.retry(retrySchedule)),

	getPr: (repoFullName, prNumber, token) =>
		Effect.gen(function* () {
			const { owner, repo } = yield* parseRepoFullName(repoFullName);
			const data = yield* conditionalFetch(
				`/repos/${owner}/${repo}/pulls/${prNumber}`,
				token
			);
			return mapPr(data as Record<string, unknown>, `${owner}/${repo}`);
		}).pipe(Effect.retry(retrySchedule)),

	getRepo: (fullName, token) =>
		Effect.gen(function* () {
			const { owner, repo } = yield* parseRepoFullName(fullName);
			const data = yield* conditionalFetch(`/repos/${owner}/${repo}`, token);
			return mapRepo(data as Record<string, unknown>);
		}).pipe(Effect.retry(retrySchedule)),

	getRepoFresh: (fullName, token) =>
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
			const data = yield* conditionalFetch(
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
			const data = yield* conditionalFetch(
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

	listPrCommits: (repoFullName, prNumber, token) =>
		Effect.gen(function* () {
			const { owner, repo } = yield* parseRepoFullName(repoFullName);
			const data = yield* githubFetch(
				`/repos/${owner}/${repo}/pulls/${prNumber}/commits?per_page=20`,
				token
			);
			// Extract parent SHAs so we can topologically sort. GitHub's docs
			// claim this endpoint returns commits "in the order they appear on
			// the branch," but that order is not stable across force-pushes,
			// cherry-picks, and unusual merge histories — the root cause of
			// reports where the dropdown shows commits in an unexpected order.
			// Walking the first-parent chain from head is deterministic.
			type RawCommit = PrCommit & { readonly parents: readonly string[] };
			const raw: RawCommit[] = (data as Record<string, unknown>[]).map((c) => {
				const commit = c['commit'] as Record<string, unknown>;
				const author = c['author'] as Record<string, unknown> | null;
				const commitAuthor = commit['author'] as Record<string, unknown> | null;
				const parentsRaw =
					(c['parents'] as Record<string, unknown>[] | undefined) ?? [];
				const parents = parentsRaw.map((p) => p['sha'] as string);
				const message = commit['message'] as string;
				return {
					sha: c['sha'] as string,
					message: message.split('\n')[0] ?? message,
					authorLogin: author ? (author['login'] as string) : null,
					authorAvatarUrl: author
						? ((author['avatar_url'] as string | null) ?? null)
						: null,
					date: commitAuthor
						? ((commitAuthor['date'] as string | null) ?? null)
						: null,
					parents,
				};
			});

			// Topological sort: walk first-parent chain from head → oldest.
			// `head` is the one commit in the list that isn't a parent of any
			// other commit in the list (base commits outside the PR aren't in
			// `inRange`, so the first PR commit's out-of-range parent is
			// correctly ignored).
			const byHash = new Map(raw.map((c) => [c.sha, c]));
			const inRange = new Set(raw.map((c) => c.sha));
			const isParentInRange = new Set<string>();
			for (const c of raw) {
				for (const p of c.parents) {
					if (inRange.has(p)) isParentInRange.add(p);
				}
			}
			const head = raw.find((c) => !isParentInRange.has(c.sha));
			const ordered: RawCommit[] = [];
			const visited = new Set<string>();
			let current: RawCommit | undefined = head;
			while (current && !visited.has(current.sha)) {
				visited.add(current.sha);
				ordered.push(current);
				const firstParent = current.parents[0];
				current = firstParent ? byHash.get(firstParent) : undefined;
			}
			// Append anything unreached (rare: disconnected merge histories).
			// Keeps those commits visible rather than silently dropping them.
			for (const c of raw) {
				if (!visited.has(c.sha)) ordered.push(c);
			}

			return ordered.map((c): PrCommit => ({
				sha: c.sha,
				message: c.message,
				authorLogin: c.authorLogin,
				authorAvatarUrl: c.authorAvatarUrl,
				date: c.date,
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

	postReview: (repoFullName, prNumber, review, token) =>
		Effect.gen(function* () {
			const { owner, repo } = yield* parseRepoFullName(repoFullName);
			const payload: Record<string, unknown> = {
				event: review.event,
				body: review.body,
			};
			if (review.comments.length > 0) {
				payload['comments'] = review.comments.map((c) => {
					const comment: Record<string, unknown> = {
						path: c.path,
						body: c.body,
						line: c.line,
						side: c.side,
					};
					if (c.startLine !== undefined && c.startLine !== c.line) {
						comment['start_line'] = c.startLine;
						comment['start_side'] = c.startSide ?? c.side;
					}
					return comment;
				});
			}
			const data = yield* githubPost(
				`/repos/${owner}/${repo}/pulls/${prNumber}/reviews`,
				token,
				payload
			);
			const raw = data as Record<string, unknown>;
			return {
				id: raw['id'] as number,
				htmlUrl: (raw['html_url'] as string | undefined) ?? '',
			};
		}),

	listReviewCommentsForReview: (repoFullName, prNumber, reviewId, token) =>
		Effect.gen(function* () {
			const { owner, repo } = yield* parseRepoFullName(repoFullName);
			const data = yield* githubFetch(
				`/repos/${owner}/${repo}/pulls/${prNumber}/reviews/${reviewId}/comments`,
				token,
			);
			const raw = data as Array<Record<string, unknown>>;
			return raw.map((c) => ({
				id: c['id'] as number,
				path: c['path'] as string,
				line: (c['line'] as number | null | undefined) ?? null,
				originalLine: (c['original_line'] as number | null | undefined) ?? null,
				body: c['body'] as string,
			}));
		}),

	postReviewComment: (repoFullName, prNumber, c, token) =>
		Effect.gen(function* () {
			const { owner, repo } = yield* parseRepoFullName(repoFullName);
			const payload: Record<string, unknown> = {
				body: c.body,
				commit_id: c.commitSha,
				path: c.path,
				line: c.line,
				side: c.side,
			};
			if (c.startLine !== undefined && c.startLine !== c.line) {
				payload['start_line'] = c.startLine;
				payload['start_side'] = c.startSide ?? c.side;
			}
			const data = yield* githubPost(
				`/repos/${owner}/${repo}/pulls/${prNumber}/comments`,
				token,
				payload
			);
			const raw = data as Record<string, unknown>;
			return {
				id: raw['id'] as number,
				htmlUrl: (raw['html_url'] as string | undefined) ?? '',
				createdAt: (raw['created_at'] as string | undefined) ?? new Date().toISOString(),
			};
		}),

	replyToComment: (repoFullName, prNumber, commentId, body, token) =>
		Effect.gen(function* () {
			const { owner, repo } = yield* parseRepoFullName(repoFullName);
			const data = yield* githubPost(
				`/repos/${owner}/${repo}/pulls/${prNumber}/comments/${commentId}/replies`,
				token,
				{ body }
			);
			const raw = data as Record<string, unknown>;
			return {
				id: raw['id'] as number,
				htmlUrl: (raw['html_url'] as string | undefined) ?? '',
				createdAt: (raw['created_at'] as string | undefined) ?? new Date().toISOString(),
			};
		}),

	listReviewComments: (repoFullName, prNumber, since, token) =>
		Effect.gen(function* () {
			const { owner, repo } = yield* parseRepoFullName(repoFullName);
			const sinceQ = since ? `&since=${encodeURIComponent(since)}` : '';
			const data = yield* githubFetchPaginated(
				`/repos/${owner}/${repo}/pulls/${prNumber}/comments?per_page=100${sinceQ}`,
				token,
				5
			);
			return (data as Record<string, unknown>[]).map((raw): GhReviewComment => {
				const user = (raw['user'] as Record<string, unknown> | null) ?? {};
				return {
					id: raw['id'] as number,
					inReplyToId: (raw['in_reply_to_id'] as number | undefined) ?? null,
					path: raw['path'] as string,
					line: (raw['line'] as number | null) ?? (raw['original_line'] as number | null) ?? null,
					startLine: (raw['start_line'] as number | null) ?? null,
					side: ((raw['side'] as 'LEFT' | 'RIGHT' | undefined) ?? 'RIGHT'),
					body: (raw['body'] as string | undefined) ?? '',
					authorLogin: (user['login'] as string | undefined) ?? '',
					authorAvatarUrl: (user['avatar_url'] as string | undefined) ?? null,
					createdAt: raw['created_at'] as string,
					updatedAt: raw['updated_at'] as string,
					htmlUrl: (raw['html_url'] as string | undefined) ?? '',
				};
			});
		}).pipe(Effect.retry(retrySchedule)),

	listReviewThreads: (repoFullName, prNumber, token) =>
		Effect.gen(function* () {
			const { owner, repo } = yield* parseRepoFullName(repoFullName);
			// GraphQL paginates at 100 per page — most PRs fit, but we page just in case.
			const query = `
				query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
					repository(owner: $owner, name: $repo) {
						pullRequest(number: $number) {
							reviewThreads(first: 100, after: $cursor) {
								pageInfo { hasNextPage endCursor }
								nodes {
									id
									isResolved
									comments(first: 100) {
										nodes { databaseId }
									}
								}
							}
						}
					}
				}
			`;
			interface ReviewThreadsResp {
				repository: {
					pullRequest: {
						reviewThreads: {
							pageInfo: { hasNextPage: boolean; endCursor: string | null };
							nodes: Array<{
								id: string;
								isResolved: boolean;
								comments: { nodes: Array<{ databaseId: number }> };
							}>;
						};
					};
				};
			}
			const out: GhReviewThread[] = [];
			let cursor: string | null = null;
			for (let p = 0; p < 5; p++) {
				const data: ReviewThreadsResp = yield* githubGraphql<ReviewThreadsResp>(
					query,
					{ owner, repo, number: prNumber, cursor },
					token
				);
				const page = data.repository.pullRequest.reviewThreads;
				for (const node of page.nodes) {
					out.push({
						nodeId: node.id,
						isResolved: node.isResolved,
						commentDatabaseIds: node.comments.nodes.map((n: { databaseId: number }) => n.databaseId),
					});
				}
				if (!page.pageInfo.hasNextPage) break;
				cursor = page.pageInfo.endCursor;
			}
			return out;
		}).pipe(Effect.retry(retrySchedule)),

	resolveReviewThread: (threadNodeId, token) =>
		Effect.gen(function* () {
			yield* githubGraphql(
				`mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { clientMutationId } }`,
				{ id: threadNodeId },
				token
			);
		}),

	unresolveReviewThread: (threadNodeId, token) =>
		Effect.gen(function* () {
			yield* githubGraphql(
				`mutation($id: ID!) { unresolveReviewThread(input: { threadId: $id }) { clientMutationId } }`,
				{ id: threadNodeId },
				token
			);
		}),

	getAuthenticatedUser: (token) =>
		Effect.gen(function* () {
			const data = yield* conditionalFetch(`/user`, token);
			const raw = data as Record<string, unknown>;
			return {
				login: raw['login'] as string,
				id: raw['id'] as number,
				avatarUrl: (raw['avatar_url'] as string | null) ?? null,
			};
		}).pipe(Effect.retry(retrySchedule)),

	getAuthenticatedUserFresh: (token) =>
		Effect.gen(function* () {
			const data = yield* githubFetch(`/user`, token);
			const raw = data as Record<string, unknown>;
			return {
				login: raw['login'] as string,
				id: raw['id'] as number,
				avatarUrl: (raw['avatar_url'] as string | null) ?? null,
			};
		}).pipe(Effect.retry(retrySchedule)),
});
