import type { PullRequest, PullRequestLocator, Repository } from "@revv/shared";
import { Effect, Option } from "effect";
import type { GitHubError, ValidationError } from "../domain/errors";

interface ResolvePullRequestLinkOperations<RRepository, RCached, RRemote, RWrite> {
  readonly findRepository: (
    fullName: string,
  ) => Effect.Effect<Repository | null, never, RRepository>;
  readonly findCachedPullRequest: (
    id: string,
  ) => Effect.Effect<Option.Option<PullRequest>, never, RCached>;
  readonly fetchPullRequest: (
    repository: Repository,
    number: number,
  ) => Effect.Effect<PullRequest, GitHubError, RRemote>;
  readonly upsertPullRequest: (
    pullRequest: PullRequest,
  ) => Effect.Effect<void, ValidationError, RWrite>;
}

export function localPullRequestId(repositoryId: string, number: number): string {
  return `${repositoryId}:${number}`;
}

export function remapPullRequestToLocalRepository(
  pullRequest: PullRequest,
  repositoryId: string,
): PullRequest {
  return {
    ...pullRequest,
    id: localPullRequestId(repositoryId, pullRequest.externalId),
    repositoryId,
  };
}

/** Targeted, account-scoped resolution. Account/host matching happens before this workflow. */
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

    const localId = localPullRequestId(repository.id, locator.number);
    const cached = yield* operations.findCachedPullRequest(localId);
    if (Option.isSome(cached)) {
      return { status: "resolved", pullRequest: cached.value } as const;
    }

    const remote = yield* operations.fetchPullRequest(repository, locator.number);
    const local = remapPullRequestToLocalRepository(remote, repository.id);
    yield* operations.upsertPullRequest(local);
    return { status: "resolved", pullRequest: local } as const;
  }).pipe(Effect.withSpan("resolvePullRequestLink"));
}
