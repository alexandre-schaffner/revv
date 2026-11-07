import type { PullRequest, Repository } from "@revv/shared";
import { Context, Effect, Layer } from "effect";
import type { DbError, GitHubAuthError, GitHubError, NotFoundError } from "../domain/errors";
import { GitHubAccounts } from "./github/accounts";
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

export type PrContextError = NotFoundError | GitHubAuthError | GitHubError | DbError;

export class PrContextService extends Context.Service<
  PrContextService,
  {
    /** A tracked repository, for work that may go on without GitHub. */
    readonly getRepo: (repoId: string) => Effect.Effect<Repository, NotFoundError | DbError>;
    readonly forRepo: (repoId: string) => Effect.Effect<RepoContext, PrContextError>;
    readonly readPr: (prId: string) => Effect.Effect<PrRecord, NotFoundError | DbError>;
    /** A PR, its repository and the owning account's client. */
    readonly forPr: (prId: string) => Effect.Effect<PrContextBasic, PrContextError>;
  }
>()("PrContextService") {}

export const PrContextServiceLive = Layer.effect(
  PrContextService,
  Effect.gen(function* () {
    const prService = yield* PullRequestService;
    const repoService = yield* RepositoryService;
    const accounts = yield* GitHubAccounts;

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

    const forPr = (prId: string) =>
      Effect.gen(function* () {
        const pr = yield* prService.getPr(prId);
        return { ...(yield* forRepo(pr.repositoryId)), pr } satisfies PrContextBasic;
      });

    return {
      getRepo: (repoId: string) => repoService.getRepoById(repoId),
      forRepo,
      readPr,
      forPr,
    };
  }),
);
