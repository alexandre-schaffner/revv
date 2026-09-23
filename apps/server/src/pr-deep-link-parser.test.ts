import { describe, expect, test } from "bun:test";
import { buildPullRequestDeepLink, parsePullRequestDeepLink } from "@revv/shared";

describe("pull request deep links", () => {
  test.each([
    ["github.com", "openai/codex", 123] as const,
    ["github.example.com", "Platform/review-tools", 7] as const,
  ])("round trips %s", (githubHost, repositoryFullName, number) => {
    const locator = { githubHost, repositoryFullName, number };
    expect(parsePullRequestDeepLink(buildPullRequestDeepLink(locator))).toEqual(locator);
  });

  test("decodes a percent-encoded repository identity", () => {
    expect(
      parsePullRequestDeepLink("revv://pr?host=GITHUB.COM&repo=owner%2Frepository&number=123"),
    ).toEqual({ githubHost: "github.com", repositoryFullName: "owner/repository", number: 123 });
  });

  test.each([
    "https://pr?host=github.com&repo=owner%2Frepo&number=1",
    "revv://review?host=github.com&repo=owner%2Frepo&number=1",
    "revv://pr?repo=owner%2Frepo&number=1",
    "revv://pr?host=github.com&host=github.example.com&repo=owner%2Frepo&number=1",
    "revv://pr?host=github.com&repo=owner%2Frepo&repo=other%2Frepo&number=1",
    "revv://pr?host=github.com&repo=owner%2Frepo&number=1&number=2",
    "revv://pr?host=github.com&repo=owner%2Frepo%2Fextra&number=1",
    "revv://pr?host=github.com&repo=owner%2Frepo&number=0",
    "revv://pr?host=github.com&repo=owner%2Frepo&number=1.5",
    "revv://pr?host=github.com&repo=owner%2Frepo&number=9007199254740992",
    "revv://pr?host=github.com&repo=owner%2Frepo&number=1&extra=true",
  ])("rejects malformed input: %s", (value) => {
    expect(parsePullRequestDeepLink(value)).toBeNull();
  });
});
