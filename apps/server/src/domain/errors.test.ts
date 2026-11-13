import { describe, expect, it } from "bun:test";
import {
  BaseConflictsRejectedError,
  DbError,
  ForbiddenError,
  GitHubApiError,
  httpErrorOf,
  NotFoundError,
  RepoNotAccessibleError,
  StackRejectedError,
  ValidationError,
  WorktreeBlockedByUnpushedCommits,
} from "./errors";

describe("httpErrorOf", () => {
  it("gives each domain error its status and code", () => {
    expect(httpErrorOf(new ValidationError({ message: "bad" }))).toEqual({
      status: 400,
      code: "INVALID",
      message: "bad",
    });
    expect(httpErrorOf(new ForbiddenError({ message: "not yours" }))).toMatchObject({
      status: 403,
      code: "FORBIDDEN",
    });
    expect(httpErrorOf(new NotFoundError({ resource: "pull request", id: "x" }))).toEqual({
      status: 404,
      code: "NOT_FOUND",
      message: "Pull request not found",
    });
    expect(
      httpErrorOf(new BaseConflictsRejectedError({ message: "m", reason: "unavailable" })),
    ).toMatchObject({ status: 503, code: "UNAVAILABLE" });
  });

  it("passes GitHub's own 4xx through and turns its 5xx into a bad gateway", () => {
    expect(httpErrorOf(new GitHubApiError({ status: 422, cause: "x" })).status).toBe(422);
    expect(httpErrorOf(new GitHubApiError({ status: 500, cause: "x" })).status).toBe(502);
  });

  it("carries the details a client reads for the code", () => {
    expect(
      httpErrorOf(
        new StackRejectedError({
          message: "m",
          rejection: { reason: "replay-conflict", files: ["a.ts"] },
        }),
      ),
    ).toEqual({ status: 409, code: "REPLAY_CONFLICT", message: "m", details: { files: ["a.ts"] } });
    expect(
      httpErrorOf(new RepoNotAccessibleError({ message: "m", detail: "d", action: null })).details,
    ).toEqual({ detail: "d" });
    expect(
      httpErrorOf(
        new WorktreeBlockedByUnpushedCommits({
          worktreePath: "/w",
          branchName: "b",
          oldHeadSha: "o",
          newHeadSha: "n",
          commits: [],
        }),
      ).details,
    ).toMatchObject({ oldHeadSha: "o", newHeadSha: "n", commits: [] });
  });

  it("answers 500 for a DB failure and for anything that isn't a domain error", () => {
    expect(httpErrorOf(new DbError({ message: "disk" }))).toMatchObject({
      status: 500,
      code: "INTERNAL_ERROR",
    });
    expect(httpErrorOf(new Error("boom"))).toEqual({
      status: 500,
      code: "INTERNAL_ERROR",
      message: "boom",
    });
    expect(httpErrorOf({ _tag: "SomethingElse" }).status).toBe(500);
  });
});
