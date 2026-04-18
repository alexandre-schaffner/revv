import { Context, Effect, Layer } from 'effect';
import type { PullRequest, Repository } from '@revv/shared';
import {
	GitHubAuthError,
	type GitHubError,
	NotFoundError,
} from '../domain/errors';
import { DbService } from './Db';
import { DiffCacheService, type CachedDiffFile } from './DiffCache';
import { GitHubService, type PrMeta } from './GitHub';
import { GitHubEtagCache } from './GitHubEtagCache';
import { PullRequestService } from './PullRequest';
import { RepositoryService } from './Repository';
import { TokenProvider } from './TokenProvider';
import { withDb } from '../effects/with-db';

/**
 * Minimal PR context — the DB-backed trio that almost every PR-scoped feature
 * needs to talk to GitHub.
 */
export interface PrContextBasic {
	readonly pr: PullRequest;
	readonly repo: Repository;
	readonly token: string;
}

/**
 * Full PR context for AI / walkthrough flows — extends {@link PrContextBasic}
 * with freshly-resolved GitHub metadata and the cached diff file list.
 */
export interface PrContextWithDiff extends PrContextBasic {
	readonly meta: PrMeta;
	readonly files: Array<{
		readonly filename: string;
		readonly previousFilename: string | null;
		readonly status: string;
		readonly additions: number;
		readonly deletions: number;
		readonly patch: string | null;
	}>;
}

type PrContextError = NotFoundError | GitHubAuthError | GitHubError;

export class PrContextService extends Context.Tag('PrContextService')<
	PrContextService,
	{
		/**
		 * Resolve the PR + repo + GitHub token for a given PR id.
		 * `userId` is passed through to {@link TokenProvider}; use `'single-user'`
		 * when the caller is a background worker with no session context.
		 */
		readonly resolveBasic: (
			prId: string,
			userId: string,
		) => Effect.Effect<PrContextBasic, PrContextError, DbService>;
		/**
		 * Resolve the basic context, plus fresh PR metadata (head/base shas) and
		 * the cached diff file list. Used by walkthrough streaming + cache checks.
		 */
		readonly resolveWithDiff: (
			prId: string,
			userId: string,
		) => Effect.Effect<PrContextWithDiff, PrContextError, DbService | GitHubEtagCache>;
	}
>() {}

export const PrContextServiceLive = Layer.effect(
	PrContextService,
	Effect.gen(function* () {
		const prService = yield* PullRequestService;
		const repoService = yield* RepositoryService;
		const tokenProvider = yield* TokenProvider;
		const github = yield* GitHubService;
		const diffCache = yield* DiffCacheService;

		const resolveBasic = (prId: string, userId: string) =>
			Effect.gen(function* () {
				const pr = yield* prService.getPr(prId);
				const repo = yield* repoService.getRepoById(pr.repositoryId);
				const token = yield* tokenProvider.getGitHubToken(userId);
				return { pr, repo, token } satisfies PrContextBasic;
			});

		// Cache-or-fetch diff files. Inlined from DiffCache.getOrFetchDiffFiles so
		// we can use the service values captured in this layer's closure without
		// leaking GitHubService / DiffCacheService into the returned Effect's
		// context requirements.
		const cacheOrFetchFiles = (
			prId: string,
			repoFullName: string,
			prExternalId: number,
			token: string,
		) =>
			Effect.gen(function* () {
				const { db } = yield* DbService;
				const cached = yield* withDb(db, diffCache.getCachedFiles(prId));
				if (cached !== null) return cached;
				const fileList = yield* github.getPrFiles(repoFullName, prExternalId, token);
				const fresh: CachedDiffFile[] = fileList.map((f) => ({
					path: f.filename,
					oldPath: f.previousFilename,
					status: f.status,
					additions: f.additions,
					deletions: f.deletions,
					patch: f.patch,
					fetchedAt: new Date().toISOString(),
				}));
				yield* withDb(db, diffCache.cacheFiles(prId, fresh));
				return fresh;
			});

		const resolveWithDiff = (prId: string, userId: string) =>
			Effect.gen(function* () {
				const basic = yield* resolveBasic(prId, userId);
				const meta = yield* github.getPrMeta(
					basic.repo.fullName,
					basic.pr.externalId,
					basic.token,
				);
				const cachedFiles = yield* cacheOrFetchFiles(
					basic.pr.id,
					basic.repo.fullName,
					basic.pr.externalId,
					basic.token,
				);
				const files = cachedFiles.map((f) => ({
					filename: f.path,
					previousFilename: f.oldPath,
					status: f.status,
					additions: f.additions,
					deletions: f.deletions,
					patch: f.patch,
				}));
				return { ...basic, meta, files } satisfies PrContextWithDiff;
			});

		return { resolveBasic, resolveWithDiff };
	}),
);
