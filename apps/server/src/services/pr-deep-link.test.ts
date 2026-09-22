import { describe, expect, test } from "bun:test";
import type { PullRequest, Repository } from "@revv/shared";
import { Effect, Option } from "effect";
import { GitHubAccessDeniedError, GitHubNetworkError, GitHubNotFoundError } from "../domain/errors";
import { resolvePullRequestLink } from "./pr-deep-link";

const repository: Repository = {
  id: "local-repo-id",
  provider: "github",
  owner: "owner",
  name: "repo",
  fullName: "owner/repo",
  defaultBranch: "main",
  avatarUrl: null,
  addedAt: "2026-01-01T00:00:00.000Z",
  cloneStatus: "pending",
  clonePath: null,
  cloneError: null,
  managed: true,
  githubHost: "github.com",
};

const remotePr: PullRequest = {
  id: "owner/repo:42",
  externalId: 42,
  repositoryId: "owner/repo",
  title: "Deep links",
  body: null,
  authorLogin: "octocat",
  authorAvatarContent: null,
  authorAvatarUrl: null,
  requestedReviewers: [],
  mentionedUsers: [],
  status: "open",
  reviewStatus: "pending",
  isDraft: false,
  sourceBranch: "feature",
  targetBranch: "main",
  url: "https://github.com/owner/repo/pull/42",
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  headSha: "head",
  baseSha: "base",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  fetchedAt: "2026-01-01T00:00:00.000Z",
  closedAt: null,
};

const locator = { githubHost: "github.com", repositoryFullName: "owner/repo", number: 42 };

describe("resolvePullRequestLink", () => {
  test("returns a cached PR without GitHub or write work", async () => {
    let fetched = false;
    let written = false;
    const cached = { ...remotePr, id: "local-repo-id:42", repositoryId: "local-repo-id" };
    const result = await Effect.runPromise(
      resolvePullRequestLink(
        {
          findRepository: () => Effect.succeed(repository),
          findCachedPullRequest: () => Effect.succeed(Option.some(cached)),
          fetchPullRequest: () => {
            fetched = true;
            return Effect.succeed(remotePr);
          },
          upsertPullRequest: () => {
            written = true;
            return Effect.void;
          },
        },
        locator,
      ),
    );
    expect(result).toEqual({ status: "resolved", pullRequest: cached });
    expect(fetched).toBe(false);
    expect(written).toBe(false);
  });

  test("fetches, remaps, and upserts a missing local PR", async () => {
    let written: PullRequest | null = null;
    const result = await Effect.runPromise(
      resolvePullRequestLink(
        {
          findRepository: () => Effect.succeed(repository),
          findCachedPullRequest: () => Effect.succeed(Option.none()),
          fetchPullRequest: () => Effect.succeed(remotePr),
          upsertPullRequest: (pullRequest) =>
            Effect.sync(() => {
              written = pullRequest;
            }),
        },
        locator,
      ),
    );
    expect(result.status).toBe("resolved");
    expect(written).toMatchObject({ id: "local-repo-id:42", repositoryId: "local-repo-id" });
  });

  test("does no PR or GitHub work when the repository is not tracked", async () => {
    let touched = false;
    const result = await Effect.runPromise(
      resolvePullRequestLink(
        {
          findRepository: () => Effect.succeed(null),
          findCachedPullRequest: () => {
            touched = true;
            return Effect.succeed(Option.none());
          },
          fetchPullRequest: () => {
            touched = true;
            return Effect.succeed(remotePr);
          },
          upsertPullRequest: () => {
            touched = true;
            return Effect.void;
          },
        },
        locator,
      ),
    );
    expect(result).toEqual({ status: "repository_not_tracked" });
    expect(touched).toBe(false);
  });

  test("does no PR or GitHub work when the stored repository belongs to another host", async () => {
    let touched = false;
    const result = await Effect.runPromise(
      resolvePullRequestLink(
        {
          findRepository: () => Effect.succeed({ ...repository, githubHost: "github.example.com" }),
          findCachedPullRequest: () => {
            touched = true;
            return Effect.succeed(Option.none());
          },
          fetchPullRequest: () => {
            touched = true;
            return Effect.succeed(remotePr);
          },
          upsertPullRequest: () => {
            touched = true;
            return Effect.void;
          },
        },
        locator,
      ),
    );
    expect(result).toEqual({ status: "repository_not_tracked" });
    expect(touched).toBe(false);
  });

  test.each([
    new GitHubAccessDeniedError({ resource: "owner/repo#42", message: "denied" }),
    new GitHubNotFoundError({ resource: "pull_request", id: "42" }),
    new GitHubNetworkError({ cause: "offline" }),
  ])("preserves GitHub error %s", async (failure) => {
    const exit = await Effect.runPromiseExit(
      resolvePullRequestLink(
        {
          findRepository: () => Effect.succeed(repository),
          findCachedPullRequest: () => Effect.succeed(Option.none()),
          fetchPullRequest: () => Effect.fail(failure),
          upsertPullRequest: () => Effect.void,
        },
        locator,
      ),
    );
    expect(exit._tag).toBe("Failure");
    expect(String(exit)).toContain(failure._tag);
  });
});
