import type { PullRequest, Repository } from "@revv/shared";
import { Context, Effect, Layer } from "effect";
import {
  type DbError,
  type GitHubAuthError,
  type GitHubError,
  GitHubNotFoundError,
  type NotFoundError,
} from "../domain/errors";
import { DiffCacheService, toGitHubFileShape } from "./DiffCache";
import { GitHubAccounts } from "./github/accounts";
import { GitHubGateway } from "./github/gateway";
import type { PrCommit, PrFileMeta } from "./github/pulls";
import type { GitHubClient } from "./github/transport";
import { PullRequestService } from "./PullRequest";
import { RepositoryService } from "./Repository";

/**
 * A PR, its repository and the account that owns it, read from the local
 * mirror alone: for work that must not depend on GitHub (or on a stored,
 * fresh token) being there.
 */
export interface PrRecord {
  readonly pr: PullRequest;
  readonly repo: Repository;
  readonly accountId: string;
}

/**
 * A tracked repository and the client of the account that owns it. Every
 * GitHub call about the repository or its PRs goes through `client`, so it
 * reaches the repository's own host as its own account.
 */
export interface RepoContext {
  readonly repo: Repository;
  readonly accountId: string;
  readonly client: GitHubClient;
}

export interface PrContextBasic extends RepoContext {
  readonly pr: PullRequest;
}

/**
 * {@link PrContextBasic} plus what an agent run needs: the PR's head and base
 * as GitHub reports them now, and the files, commits, title and body of that
 * head.
 */
export interface PrContextWithDiff extends PrContextBasic {
  readonly meta: { readonly headSha: string; readonly baseSha: string };
  readonly files: PrFileMeta[];
  readonly commits: readonly PrCommit[];
}

export type PrContextError = NotFoundError | GitHubAuthError | GitHubError | DbError;

export class PrContextService extends Context.Service<
  PrContextService,
  {
    /** A tracked repository, for work that may go on without GitHub. */
    readonly getRepo: (repoId: string) => Effect.Effect<Repository, NotFoundError | DbError>;
    readonly forRepo: (repoId: string) => Effect.Effect<RepoContext, PrContextError>;
    readonly readPr: (prId: string) => Effect.Effect<PrRecord, NotFoundError | DbError>;
    /**
     * A PR, its repository and the owning account's client. With `accountId`,
     * a PR outside that account's repositories is not found.
     */
    readonly forPr: (
      prId: string,
      accountId?: string,
    ) => Effect.Effect<PrContextBasic, PrContextError>;
    /** {@link forPr} plus the PR's live head/base, its diff files and its commits. */
    readonly withDiff: (prId: string) => Effect.Effect<PrContextWithDiff, PrContextError>;
  }
>()("PrContextService") {}

export const PrContextServiceLive = Layer.effect(
  PrContextService,
  Effect.gen(function* () {
    const prService = yield* PullRequestService;
    const repoService = yield* RepositoryService;
    const accounts = yield* GitHubAccounts;
    const github = yield* GitHubGateway;
    const diffCache = yield* DiffCacheService;

    const forRepo = (repoId: string) =>
      Effect.gen(function* () {
        const repo = yield* repoService.getRepoById(repoId);
        const accountId = yield* repoService.getAccountIdForRepo(repo.id);
        const client = yield* accounts.clientFor(accountId);
        return { repo, accountId, client } satisfies RepoContext;
      });

    const readPr = (prId: string) =>
      Effect.gen(function* () {
        const pr = yield* prService.getPr(prId);
        const repo = yield* repoService.getRepoById(pr.repositoryId);
        const accountId = yield* repoService.getAccountIdForRepo(repo.id);
        return { pr, repo, accountId } satisfies PrRecord;
      });

    const forPr = (prId: string, accountId?: string) =>
      Effect.gen(function* () {
        const pr = yield* prService.getPr(prId, accountId);
        return { ...(yield* forRepo(pr.repositoryId)), pr } satisfies PrContextBasic;
      });

    const withDiff = (prId: string) =>
      Effect.gen(function* () {
        const basic = yield* forPr(prId);
        const { repo, pr, client } = basic;
        const live = yield* github.prs.get(client, repo.fullName, repo.id, pr.externalId);
        if (live.headSha === null || live.baseSha === null) {
          return yield* Effect.fail(
            new GitHubNotFoundError({
              resource: "pull_request",
              id: `${repo.fullName}#${pr.externalId}`,
            }),
          );
        }
        // The cache holds the stored row's head. Until the poll records a push
        // GitHub already reports, the live head's files come from GitHub.
        const files =
          live.headSha === pr.headSha && live.baseSha === pr.baseSha
            ? toGitHubFileShape((yield* diffCache.getOrFetch(pr, repo.fullName, client)).files)
            : yield* github.prs.files(client, repo.fullName, pr.externalId);
        const commits = yield* github.prs.commits(client, repo.fullName, pr.externalId);
        return {
          ...basic,
          pr: {
            ...pr,
            title: live.title,
            body: live.body,
            headSha: live.headSha,
            baseSha: live.baseSha,
          },
          meta: { headSha: live.headSha, baseSha: live.baseSha },
          files,
          commits,
        } satisfies PrContextWithDiff;
      });

    return {
      getRepo: (repoId: string) => repoService.getRepoById(repoId),
      forRepo,
      readPr,
      forPr,
      withDiff,
    };
  }),
);
