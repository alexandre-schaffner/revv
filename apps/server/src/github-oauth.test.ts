import { describe, expect, it } from "bun:test";
import { isLikelyGitHubClientId } from "@revv/shared";
import { clientIdForHost, InvalidGitHubClientIdError } from "./github-oauth";

describe("GitHub client ID validation", () => {
  it("accepts GitHub App and OAuth App client ID shapes", () => {
    expect(isLikelyGitHubClientId("Iv23li1234567890")).toBe(true);
    expect(isLikelyGitHubClientId("Ov23li1234567890")).toBe(true);
  });

  it("rejects malformed client IDs before starting device flow", () => {
    expect(isLikelyGitHubClientId("not-a-client-id")).toBe(false);
    expect(() => clientIdForHost("ghe.example.com", "not-a-client-id")).toThrow(
      InvalidGitHubClientIdError,
    );
  });
});
