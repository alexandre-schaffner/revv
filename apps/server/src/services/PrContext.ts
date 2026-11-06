import type { PullRequest, Repository } from "@revv/shared";
import { Context, Effect, Layer } from "effect";
import {
  type DbError,
  type GitHubAuthError,
  type GitHubError,
  GitHubNotFoundError,
  type NotFoundError,
} from "../domain/errors";
import { withDb } from "../effects/with-db";
import { DbService } from "./Db";
import { DiffCacheService, toGitHubFileShape } from "./DiffCache";
import { GitHubAccounts } from "./github/accounts";
import { GitHubGateway } from "./github/gateway";
import type { PrCommit, PrFileMeta } from "./github/pulls";
import type { GitHubClient } from "./github/transport";
import { PullRequestService } from "./PullRequest";
import { RepositoryService } from "./Repository";

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
 * as GitHub reports them now, its changed files and its commits.
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
    readonly getRepo: (repoId: string) => Effect.Effect<Repository, NotFoundError>;
    readonly forRepo: (repoId: string) => Effect.Effect<RepoContext, PrContextError>;
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
    const { db } = yield* DbService;
    const prService = yield* PullRequestService;
    const repoService = yield* RepositoryService;
    const accounts = yield* GitHubAccounts;
    const github = yield* GitHubGateway;
    const diffCache = yield* DiffCacheService;

    const forRepo = (repoId: string) =>
      Effect.gen(function* () {
        const repo = yield* withDb(db, repoService.getRepoById(repoId));
        const accountId = yield* withDb(db, repoService.getAccountIdForRepo(repo.id));
        const client = yield* accounts.clientFor(accountId);
        return { repo, accountId, client } satisfies RepoContext;
      });

    const forPr = (prId: string, accountId?: string) =>
      Effect.gen(function* () {
        const pr = yield* withDb(db, prService.getPr(prId, accountId));
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
        const { files } = yield* diffCache.getOrFetch(pr, repo.fullName, client);
        const commits = yield* github.prs.commits(client, repo.fullName, pr.externalId);
        return {
          ...basic,
          meta: { headSha: live.headSha, baseSha: live.baseSha },
          files: toGitHubFileShape(files),
          commits,
        } satisfies PrContextWithDiff;
      });

    return {
      getRepo: (repoId: string) => withDb(db, repoService.getRepoById(repoId)),
      forRepo,
      forPr,
      withDiff,
    };
  }),
);
