import { describe, expect, it } from "bun:test";
import {
  isIntegrationCredentialActive,
  selectPullRequestForCheckout,
} from "./ExternalIntegrations";

describe("isIntegrationCredentialActive", () => {
  const now = Date.parse("2026-09-22T12:00:00.000Z");

  it("requires an unrevoked future expiry", () => {
    expect(
      isIntegrationCredentialActive(
        { revokedAt: null, expiresAt: "2026-09-23T12:00:00.000Z" },
        now,
      ),
    ).toBe(true);
    expect(
      isIntegrationCredentialActive(
        { revokedAt: null, expiresAt: "2026-09-21T12:00:00.000Z" },
        now,
      ),
    ).toBe(false);
    expect(
      isIntegrationCredentialActive(
        {
          revokedAt: "2026-09-22T11:00:00.000Z",
          expiresAt: "2026-09-23T12:00:00.000Z",
        },
        now,
      ),
    ).toBe(false);
  });
});

describe("selectPullRequestForCheckout", () => {
  const pullRequests = [
    { id: "older", headSha: "a".repeat(40), sourceBranch: "feature" },
    { id: "newer", headSha: "b".repeat(40), sourceBranch: "feature-two" },
  ];

  it("prefers the nearest reviewed head in the checkout ancestry", () => {
    const selected = selectPullRequestForCheckout(
      pullRequests,
      ["c".repeat(40), "b".repeat(40), "a".repeat(40)],
      null,
    );
    expect(selected?.id).toBe("newer");
  });

  it("uses an unambiguous branch only when no head matches", () => {
    const selected = selectPullRequestForCheckout(pullRequests, ["c".repeat(40)], "feature");
    expect(selected?.id).toBe("older");
  });

  it("does not guess when a branch matches more than one pull request", () => {
    const selected = selectPullRequestForCheckout(
      [...pullRequests, { id: "duplicate", headSha: "d".repeat(40), sourceBranch: "feature" }],
      ["c".repeat(40)],
      "feature",
    );
    expect(selected).toBeNull();
  });

  it("ignores pull requests whose head is unknown", () => {
    const selected = selectPullRequestForCheckout(
      [{ id: "unsynced", headSha: null, sourceBranch: "feature" }],
      ["a".repeat(40)],
      null,
    );
    expect(selected).toBeNull();
  });
});
