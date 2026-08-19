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

describe("clientIdForHost host resolution", () => {
  // Regression: a stale BYO GHE client_id left in settings after switching back
  // to a github.com account must NOT be applied to github.com — it 404s on
  // github.com's device-code endpoint. github.com always uses the bundled id.
  it("ignores a custom (GHE) client id on github.com and uses the bundled id", () => {
    const bundled = clientIdForHost("github.com", null);
    const leakedGheId = "Iv23g4k6FNfeW0S9tUca";
    expect(clientIdForHost("github.com", leakedGheId)).toBe(bundled);
    expect(clientIdForHost("github.com", leakedGheId)).not.toBe(leakedGheId);
    expect(bundled.length).toBeGreaterThan(0);
  });

  it("uses the supplied custom client id for a GHE host", () => {
    const gheId = "Iv23li1234567890";
    expect(clientIdForHost("ghe.example.com", gheId)).toBe(gheId);
  });
});
