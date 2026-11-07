import type { PullRequest, PullRequestLocator, Repository } from "@revv/shared";
import { Effect, Option } from "effect";
import type { DbError, GitHubError } from "../domain/errors";
import { asStored, localPrId, type ObservedPr } from "../domain/observed-pr";

interface ResolvePullRequestLinkOperations<RRepository, RCached, RRemote, RWrite> {
  readonly findRepository: (
    fullName: string,
  ) => Effect.Effect<Repository | null, DbError, RRepository>;
  readonly findCachedPullRequest: (
    id: string,
  ) => Effect.Effect<Option.Option<PullRequest>, never, RCached>;
  readonly fetchPullRequest: (
    repository: Repository,
    number: number,
  ) => Effect.Effect<ObservedPr, GitHubError, RRemote>;
  readonly upsertPullRequest: (pullRequest: ObservedPr) => Effect.Effect<void, DbError, RWrite>;
}

/** The caller has matched the account to the link's host and scoped each operation to it. */
export function resolvePullRequestLink<RRepository, RCached, RRemote, RWrite>(
  operations: ResolvePullRequestLinkOperations<RRepository, RCached, RRemote, RWrite>,
  locator: PullRequestLocator,
) {
  return Effect.gen(function* () {
    const repository = yield* operations.findRepository(locator.repositoryFullName);
    if (!repository) return { status: "repository_not_tracked" } as const;
    if (repository.githubHost.toLowerCase() !== locator.githubHost) {
      return { status: "repository_not_tracked" } as const;
    }

    const localId = localPrId(repository.id, locator.number);
    const cached = yield* operations.findCachedPullRequest(localId);
    if (Option.isSome(cached)) {
      return { status: "resolved", pullRequest: cached.value } as const;
    }

    const remote = yield* operations.fetchPullRequest(repository, locator.number);
    yield* operations.upsertPullRequest(remote);
    return { status: "resolved", pullRequest: asStored(remote, undefined) } as const;
  }).pipe(Effect.withSpan("resolvePullRequestLink"));
}
