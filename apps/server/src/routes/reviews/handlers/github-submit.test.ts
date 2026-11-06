import { describe, expect, it } from "bun:test";
import { GitHubApiError } from "../../../domain/errors";
import { isExistingPendingReviewError } from "./github-submit";

const rejection = (status: number, body: string) =>
  new GitHubApiError({ status, cause: `HTTP ${status} for /repos/o/r/pulls/1/reviews: ${body}` });

describe("isExistingPendingReviewError", () => {
  it("matches GitHub's exact pending-review response", () => {
    expect(
      isExistingPendingReviewError(
        rejection(422, '{"errors":["User can only have one pending review per pull request"]}'),
      ),
    ).toBe(true);
  });

  it("matches broader 422 pending-review wording", () => {
    expect(
      isExistingPendingReviewError(
        rejection(422, "pending review already exists for this pull request"),
      ),
    ).toBe(true);
  });

  it("does not match unrelated 422 responses", () => {
    expect(isExistingPendingReviewError(rejection(422, "validation failed"))).toBe(false);
  });

  it("does not match the wording on another status", () => {
    expect(isExistingPendingReviewError(rejection(409, "pending review"))).toBe(false);
  });
});
