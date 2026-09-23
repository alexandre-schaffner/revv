import { describe, expect, it } from "bun:test";
import type { UserSettings } from "@revv/shared";
import { Effect, Layer, Stream } from "effect";
import { JevService, JevServiceLive } from "./Jev";
import { SecretStore } from "./SecretStore";
import { SettingsService } from "./Settings";

// "Off is free": disabled toggle / missing key must resolve with no network call.
// Enforced by booby-trapping fetch so any wire access throws.

function fakeSettings(jev: Partial<UserSettings["jev"]>) {
  const settings = {
    jev: {
      enabled: false,
      hasApiKey: false,
      ...jev,
    },
  } as UserSettings;
  return Layer.succeed(SettingsService, {
    getSettings: () => Effect.succeed(settings),
    updateSettings: () => Effect.succeed(settings),
    settingsChanges: () => Stream.empty,
    resolveAgent: () => Effect.succeed("opencode" as const),
    resolveRecapAgent: () => Effect.succeed("opencode" as const),
    resolveChatAgentId: () => Effect.succeed("opencode" as const),
  });
}

function fakeSecrets(secrets: Record<string, string>) {
  return Layer.succeed(SecretStore, {
    setTokens: () => Effect.void,
    getTokens: () => Effect.succeed(null),
    deleteTokens: () => Effect.void,
    setSecret: () => Effect.void,
    getSecret: (key: string) => Effect.succeed(secrets[key] ?? null),
    deleteSecret: () => Effect.void,
  });
}

function layerFor(jev: Partial<UserSettings["jev"]>, secrets: Record<string, string> = {}) {
  return JevServiceLive.pipe(Layer.provide(Layer.merge(fakeSettings(jev), fakeSecrets(secrets))));
}

/** Run with `fetch` booby-trapped, so any network use fails the test. */
async function withoutNetwork<A>(run: () => Promise<A>): Promise<A> {
  const original = globalThis.fetch;
  globalThis.fetch = ((): never => {
    throw new Error("network call attempted on a short-circuit path");
  }) as unknown as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

const probe = {
  label: "job-start" as const,
  state: { probe: true },
  questions: { q: { type: "noul" as const, instructions: "anything" } },
  timeoutMs: 1_000,
};

describe("JevService", () => {
  it("fails with 'disabled' — without touching the network — when the master switch is off", async () => {
    const result = await withoutNetwork(() =>
      Effect.runPromise(
        Effect.flatMap(JevService, (jev) => jev.ask(probe)).pipe(
          Effect.provide(layerFor({ enabled: false }, { "jev-api-key": "apikey_test" })),
          Effect.either,
        ),
      ),
    );
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") expect(result.left.reason).toBe("disabled");
  });

  it("fails with 'unconfigured' — without touching the network — when no key is stored", async () => {
    const result = await withoutNetwork(() =>
      Effect.runPromise(
        Effect.flatMap(JevService, (jev) => jev.ask(probe)).pipe(
          Effect.provide(layerFor({ enabled: true })),
          Effect.either,
        ),
      ),
    );
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") expect(result.left.reason).toBe("unconfigured");
  });

  it("reports unavailable when enabled without a key, and available with one", async () => {
    const withoutKey = await withoutNetwork(() =>
      Effect.runPromise(
        Effect.flatMap(JevService, (jev) => jev.isAvailable()).pipe(
          Effect.provide(layerFor({ enabled: true })),
        ),
      ),
    );
    expect(withoutKey).toBe(false);

    const withKey = await withoutNetwork(() =>
      Effect.runPromise(
        Effect.flatMap(JevService, (jev) => jev.isAvailable()).pipe(
          Effect.provide(layerFor({ enabled: true }, { "jev-api-key": "apikey_test" })),
        ),
      ),
    );
    expect(withKey).toBe(true);
  });

  it("maps an unreachable API onto a 'transport' failure rather than a defect", async () => {
    // Resolvable key, unreachable host; only asserts the rejection is classified, not that it's fast.
    const previousBase = process.env.TYPESAFE_BASE_URL;
    process.env.TYPESAFE_BASE_URL = "http://127.0.0.1:1";
    try {
      const result = await Effect.runPromise(
        Effect.flatMap(JevService, (jev) => jev.ask({ ...probe, timeoutMs: 3_000 })).pipe(
          Effect.provide(layerFor({ enabled: true }, { "jev-api-key": "apikey_test" })),
          Effect.either,
        ),
      );
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect(["transport", "timeout"]).toContain(result.left.reason);
      }
    } finally {
      if (previousBase === undefined) delete process.env.TYPESAFE_BASE_URL;
      else process.env.TYPESAFE_BASE_URL = previousBase;
    }
  });

  it("honours the caller's timeout budget", async () => {
    const previousBase = process.env.TYPESAFE_BASE_URL;
    // Black-hole address: connections hang rather than refuse, so the budget (not the OS) ends the call.
    process.env.TYPESAFE_BASE_URL = "http://10.255.255.1:81";
    try {
      const startedAt = Date.now();
      const result = await Effect.runPromise(
        Effect.flatMap(JevService, (jev) => jev.ask({ ...probe, timeoutMs: 300 })).pipe(
          Effect.provide(layerFor({ enabled: true }, { "jev-api-key": "apikey_test" })),
          Effect.either,
        ),
      );
      expect(result._tag).toBe("Left");
      expect(Date.now() - startedAt).toBeLessThan(5_000);
    } finally {
      if (previousBase === undefined) delete process.env.TYPESAFE_BASE_URL;
      else process.env.TYPESAFE_BASE_URL = previousBase;
    }
  });
});
