import { afterEach, describe, expect, it } from "bun:test";
import { isLikelyGitHubClientId } from "@revv/shared";
import { Effect, Exit } from "effect";
import { clientIdForHost, startDeviceFlow } from "./oauth";

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

describe("startDeviceFlow", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const OLD = "Iv23oldoldoldold";
  const NEW = "Iv23newnewnewnew";
  const CODE = {
    device_code: "dc",
    user_code: "ABCD-1234",
    verification_uri: "https://ghe.example.com/login/device",
    expires_in: 900,
    interval: 5,
  };

  /** GitHub knowing only `known`; anything else answers `refused`. */
  function stubDeviceCode(known: string, refused = 404) {
    const asked: string[] = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const { client_id } = JSON.parse(String(init.body)) as { client_id: string };
      asked.push(client_id);
      return client_id === known
        ? new Response(JSON.stringify(CODE))
        : new Response("", { status: refused });
    }) as unknown as typeof fetch;
    return asked;
  }

  it("falls back to the next client when GitHub refuses one", async () => {
    const asked = stubDeviceCode(NEW);
    const started = await Effect.runPromise(startDeviceFlow("ghe.example.com", [OLD, NEW]));
    expect(started).toEqual({ clientId: NEW, code: CODE });
    expect(asked).toEqual([OLD, NEW]);
  });

  it("keeps the first client GitHub accepts", async () => {
    const asked = stubDeviceCode(OLD);
    const started = await Effect.runPromise(startDeviceFlow("ghe.example.com", [OLD, NEW]));
    expect(started.clientId).toBe(OLD);
    expect(asked).toEqual([OLD]);
  });

  it("refuses with an invalid client id once every client is refused", async () => {
    stubDeviceCode("none", 401);
    const exit = await Effect.runPromiseExit(startDeviceFlow("ghe.example.com", [OLD, NEW]));
    expect(exit).toEqual(
      Exit.fail(
        expect.objectContaining({ _tag: "InvalidGitHubClientIdError", host: "ghe.example.com" }),
      ),
    );
  });

  it("stops at a server failure instead of trying another client", async () => {
    const asked = stubDeviceCode("none", 503);
    const exit = await Effect.runPromiseExit(startDeviceFlow("ghe.example.com", [OLD, NEW]));
    expect(exit).toEqual(
      Exit.fail(expect.objectContaining({ _tag: "GitHubApiError", status: 503 })),
    );
    expect(asked).toEqual([OLD]);
  });
});
