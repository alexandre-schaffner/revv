import { describe, expect, it } from "bun:test";
import { GitHubNetworkError } from "../../../domain/errors";
import { isExistingPendingReviewError } from "./github-submit";

describe("isExistingPendingReviewError", () => {
  it("matches GitHub's exact pending-review response", () => {
    expect(
      isExistingPendingReviewError(
        new GitHubNetworkError({
          cause:
            '422 Unprocessable Entity: {"errors":["User can only have one pending review per pull request"]}',
        }),
      ),
    ).toBe(true);
  });

  it("matches broader 422 pending-review wording", () => {
    expect(
      isExistingPendingReviewError(
        new GitHubNetworkError({
          cause: "422 Unprocessable Entity: pending review already exists for this pull request",
        }),
      ),
    ).toBe(true);
  });

  it("does not match unrelated 422 responses", () => {
    expect(
      isExistingPendingReviewError(
        new GitHubNetworkError({
          cause: "422 Unprocessable Entity: validation failed",
        }),
      ),
    ).toBe(false);
  });
});
