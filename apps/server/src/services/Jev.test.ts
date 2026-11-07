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
    githubHost: () => Effect.succeed(settings.githubHost),
    watch: () => Stream.empty,
    resolveAgent: () => Effect.succeed("opencode" as const),
    resolveRecapAgent: () => Effect.succeed("opencode" as const),
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

async function withFetch<A>(
  fake: (input: unknown, init?: RequestInit) => Promise<Response>,
  run: () => Promise<A>,
): Promise<A> {
  const original = globalThis.fetch;
  globalThis.fetch = Object.assign(fake, { preconnect: original.preconnect });
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

const withoutNetwork = <A>(run: () => Promise<A>): Promise<A> =>
  withFetch(() => {
    throw new Error("network call attempted on a short-circuit path");
  }, run);

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
          Effect.result,
        ),
      ),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.reason).toBe("disabled");
  });

  it("fails with 'unconfigured' — without touching the network — when no key is stored", async () => {
    const result = await withoutNetwork(() =>
      Effect.runPromise(
        Effect.flatMap(JevService, (jev) => jev.ask(probe)).pipe(
          Effect.provide(layerFor({ enabled: true })),
          Effect.result,
        ),
      ),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.reason).toBe("unconfigured");
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
    const result = await withFetch(
      () => Promise.reject(new TypeError("Unable to connect")),
      () =>
        Effect.runPromise(
          Effect.flatMap(JevService, (jev) => jev.ask({ ...probe, timeoutMs: 30_000 })).pipe(
            Effect.provide(layerFor({ enabled: true }, { "jev-api-key": "apikey_test" })),
            Effect.result,
          ),
        ),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.reason).toBe("transport");
  });

  it("ends a stalled call at the caller's timeout budget", async () => {
    const hangUntilAborted = (_input: unknown, init?: RequestInit) =>
      new Promise<never>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    const startedAt = Date.now();
    const result = await withFetch(hangUntilAborted, () =>
      Effect.runPromise(
        Effect.flatMap(JevService, (jev) => jev.ask({ ...probe, timeoutMs: 300 })).pipe(
          Effect.provide(layerFor({ enabled: true }, { "jev-api-key": "apikey_test" })),
          Effect.result,
        ),
      ),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.reason).toBe("timeout");
    // Well under the SDK's own 10 s per-attempt timeout.
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });
});
