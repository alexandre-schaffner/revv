import { describe, expect, it } from "bun:test";
import { isLikelyGitHubClientId } from "@revv/shared";
import { Effect, Exit } from "effect";
import { clientIdForHost } from "./oauth";

const resolve = (host: string, custom: string | null) =>
  Effect.runSyncExit(clientIdForHost(host, custom));

describe("GitHub client ID validation", () => {
  it("accepts GitHub App and OAuth App client ID shapes", () => {
    expect(isLikelyGitHubClientId("Iv23li1234567890")).toBe(true);
    expect(isLikelyGitHubClientId("Ov23li1234567890")).toBe(true);
  });

  it("rejects malformed client IDs before starting device flow", () => {
    expect(isLikelyGitHubClientId("not-a-client-id")).toBe(false);
    expect(resolve("ghe.example.com", "not-a-client-id")).toEqual(
      Exit.fail(
        expect.objectContaining({ _tag: "InvalidGitHubClientIdError", host: "ghe.example.com" }),
      ),
    );
  });
});

describe("clientIdForHost host resolution", () => {
  // A stale BYO GHE client_id left in settings after switching back to a
  // github.com account must NOT be applied to github.com — it 404s on
  // github.com's device-code endpoint. github.com always uses the bundled id.
  it("ignores a custom (GHE) client id on github.com and uses the bundled id", () => {
    const bundled = Effect.runSync(clientIdForHost("github.com", null));
    const leakedGheId = "Iv23g4k6FNfeW0S9tUca";
    expect(Effect.runSync(clientIdForHost("github.com", leakedGheId))).toBe(bundled);
    expect(bundled).not.toBe(leakedGheId);
    expect(bundled.length).toBeGreaterThan(0);
  });

  it("uses the supplied custom client id for a GHE host", () => {
    const gheId = "Iv23li1234567890";
    expect(Effect.runSync(clientIdForHost("ghe.example.com", gheId))).toBe(gheId);
  });
});
