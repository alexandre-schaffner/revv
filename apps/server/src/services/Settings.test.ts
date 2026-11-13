import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applySettingsUpdate,
  DEFAULT_USER_SETTINGS,
  getAgentCapabilities,
  mergeSettingsUpdate,
  normalizeSettings,
  type SettingsUpdate,
  type UserSettings,
} from "@revv/shared";
import { Effect, Fiber, Layer, Stream } from "effect";
import { createDb, type Db } from "../db";
import { userSettings } from "../db/schema/user-settings";
import { DbService } from "./Db";
import { SettingsService, settingsServiceLayer } from "./Settings";

const CURRENT: UserSettings = {
  ...DEFAULT_USER_SETTINGS,
  aiAgent: "claude-code",
  aiModel: "claude-sonnet-5",
  aiSuggestionsModel: "claude-haiku-4-5-20251001",
  cache: {
    enabled: true,
    bucket: "team-bucket",
    uploadsEnabled: true,
    downloadsEnabled: true,
    signing: { mode: "strict", keyPath: "/k", trustedSignerHosts: ["github.com"] },
  },
  jev: { enabled: true, hasApiKey: true },
};

describe("normalizeSettings", () => {
  it("fills every field from defaults when given nothing", () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_USER_SETTINGS);
    expect(normalizeSettings("garbage")).toEqual(DEFAULT_USER_SETTINGS);
  });

  it("replaces invalid values with defaults and keeps valid ones", () => {
    const s = normalizeSettings({
      aiAgent: "removed-agent",
      updateChannel: "beta",
      diffViewMode: "split",
      aiThinkingEffort: "galaxy-brain",
      githubHost: "",
      cache: { signing: { mode: "paranoid", trustedSignerHosts: ["ghe.example", 7] } },
    });
    expect(s.aiAgent).toBe(DEFAULT_USER_SETTINGS.aiAgent);
    expect(s.updateChannel).toBe(DEFAULT_USER_SETTINGS.updateChannel);
    expect(s.diffViewMode).toBe("split");
    expect(s.aiThinkingEffort).toBe(DEFAULT_USER_SETTINGS.aiThinkingEffort);
    expect(s.githubHost).toBe("github.com");
    expect(s.cache.signing.mode).toBe("strict");
    expect(s.cache.signing.trustedSignerHosts).toEqual(["ghe.example"]);
  });

  it("maps the retired `claude` agent id onto `claude-code`", () => {
    const s = normalizeSettings({ aiAgent: "claude", recap: { agent: "claude" } });
    expect(s.aiAgent).toBe("claude-code");
    expect(s.recap.agent).toBe("claude-code");
  });

  it("stores the GitHub host normalized, whatever form it arrived in", () => {
    expect(normalizeSettings({ githubHost: " https://GHE.Example.com/ " }).githubHost).toBe(
      "ghe.example.com",
    );
  });

  it("floors and clamps max turns", () => {
    expect(normalizeSettings({ aiMaxTurns: 3.7 }).aiMaxTurns).toBe(10);
    expect(normalizeSettings({ aiMaxTurns: 99.9 }).aiMaxTurns).toBe(99);
    expect(normalizeSettings({ aiMaxTurns: 9000 }).aiMaxTurns).toBe(500);
  });

  it("is idempotent", () => {
    const once = normalizeSettings({ aiAgent: "claude", aiMaxTurns: 1, diffViewMode: 3 });
    expect(normalizeSettings(once)).toEqual(once);
  });
});

describe("mergeSettingsUpdate", () => {
  it("applies a top-level scalar without touching anything else", () => {
    const next = mergeSettingsUpdate(CURRENT, { aiModel: "claude-opus-5" });
    expect(next.aiModel).toBe("claude-opus-5");
    expect(next.jev).toEqual(CURRENT.jev);
    expect(next.cache).toEqual(CURRENT.cache);
  });

  it("keeps hasApiKey, which no client patch can carry", () => {
    const next = mergeSettingsUpdate(CURRENT, { jev: { enabled: false } });
    expect(next.jev.hasApiKey).toBe(true);
  });

  it("deep-merges cache.signing and replaces lists", () => {
    const next = mergeSettingsUpdate(CURRENT, {
      cache: { signing: { mode: "off", trustedSignerHosts: ["ghe.example"] } },
    });
    expect(next.cache.signing).toEqual({
      mode: "off",
      keyPath: "/k",
      trustedSignerHosts: ["ghe.example"],
    });
    expect(next.cache.bucket).toBe("team-bucket");
  });

  // A new nested group fails here rather than shipping as settings turning themselves off.
  it("deep-merges every nested object on UserSettings", () => {
    for (const [key, value] of Object.entries(CURRENT)) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
      const [first, ...siblings] = Object.entries(value);
      if (!first) continue;
      const [firstKey, firstValue] = first;
      const patch = {
        [key]: { [firstKey]: typeof firstValue === "boolean" ? !firstValue : firstValue },
      } as SettingsUpdate;
      const merged = (mergeSettingsUpdate(CURRENT, patch) as unknown as Record<string, unknown>)[
        key
      ];
      for (const [siblingKey, siblingValue] of siblings) {
        expect((merged as Record<string, unknown>)[siblingKey]).toEqual(siblingValue);
      }
    }
  });
});

describe("applySettingsUpdate", () => {
  it("brings the agent's model, suggestions model and effort along on a switch", () => {
    const next = applySettingsUpdate(
      { ...DEFAULT_USER_SETTINGS, aiThinkingEffort: "ultra" },
      { aiAgent: "claude-code" },
    );
    const claude = getAgentCapabilities("claude-code");
    expect(next.aiAgent).toBe("claude-code");
    expect(next.aiModel).toBe(claude.defaultModel);
    expect(next.aiSuggestionsModel).toBe(claude.suggestionsModel);
    expect(next.aiThinkingEffort).toBe("high");
  });

  it("lets fields the patch sets win over the cascade", () => {
    const next = applySettingsUpdate(DEFAULT_USER_SETTINGS, {
      aiAgent: "codex",
      aiModel: "gpt-6-astra",
      aiThinkingEffort: "ultra",
    });
    expect(next.aiModel).toBe("gpt-6-astra");
    expect(next.aiThinkingEffort).toBe("ultra");
    expect(next.aiSuggestionsModel).toBe(getAgentCapabilities("codex").suggestionsModel);
  });

  it("leaves the model alone when the agent doesn't change", () => {
    const next = applySettingsUpdate(CURRENT, { aiAgent: "claude-code" });
    expect(next.aiModel).toBe(CURRENT.aiModel);
  });

  it("keeps the Auto sentinel across a switch between static catalogs", () => {
    const next = applySettingsUpdate(
      { ...CURRENT, aiModel: "revv:auto", aiThinkingEffort: "revv:auto" },
      { aiAgent: "codex" },
    );
    expect(next.aiModel).toBe("revv:auto");
    expect(next.aiThinkingEffort).toBe("revv:auto");
  });
});

describe("SettingsService", () => {
  // Never the real `~/.revv/settings.json`: the import deletes the file it reads.
  let legacyDir: string;
  let legacyPath: string;

  beforeAll(() => {
    legacyDir = mkdtempSync(join(tmpdir(), "revv-settings-"));
    legacyPath = join(legacyDir, "settings.json");
  });

  afterAll(() => {
    rmSync(legacyDir, { recursive: true, force: true });
  });

  const run = <A, E>(db: Db, use: Effect.Effect<A, E, SettingsService>) =>
    Effect.runPromise(
      use.pipe(
        Effect.provide(
          settingsServiceLayer(legacyPath).pipe(Layer.provide(Layer.succeed(DbService, { db }))),
        ),
      ),
    );

  it("seeds the row from defaults on first boot", async () => {
    const db = createDb(":memory:");
    expect(
      await run(
        db,
        Effect.flatMap(SettingsService, (s) => s.getSettings()),
      ),
    ).toEqual(DEFAULT_USER_SETTINGS);
    expect(db.select().from(userSettings).all()).toHaveLength(1);
  });

  it("points a first boot's row at the install's host, and leaves an existing row's be", async () => {
    const db = createDb(":memory:");
    const atHost = (host: string) =>
      Effect.runPromise(
        Effect.flatMap(SettingsService, (s) => s.githubHost()).pipe(
          Effect.provide(
            settingsServiceLayer(legacyPath, host).pipe(
              Layer.provide(Layer.succeed(DbService, { db })),
            ),
          ),
        ),
      );
    expect(await atHost("ghe.example.com")).toBe("ghe.example.com");
    expect(await atHost("github.com")).toBe("ghe.example.com");
  });

  it("seeds the default host from a set-but-empty GITHUB_HOST, and a normalized one otherwise", async () => {
    const firstBoot = (host: string) =>
      Effect.runPromise(
        Effect.flatMap(SettingsService, (s) => s.githubHost()).pipe(
          Effect.provide(
            settingsServiceLayer(legacyPath, host).pipe(
              Layer.provide(Layer.succeed(DbService, { db: createDb(":memory:") })),
            ),
          ),
        ),
      );
    expect(await firstBoot("")).toBe(DEFAULT_USER_SETTINGS.githubHost);
    expect(await firstBoot("https://GHE.example.com/")).toBe("ghe.example.com");
  });

  it("imports the legacy JSON file, including its separate chat agent", async () => {
    writeFileSync(
      legacyPath,
      JSON.stringify({ chatAgent: "codex", diffViewMode: "split", aiMaxTurns: 120 }),
    );
    const db = createDb(":memory:");
    const s = await run(
      db,
      Effect.flatMap(SettingsService, (svc) => svc.getSettings()),
    );
    expect(s.aiAgent).toBe("codex");
    expect(s.diffViewMode).toBe("split");
    expect(s.aiMaxTurns).toBe(120);
  });

  it("persists the normalized, cascaded patch and reads it back", async () => {
    const db = createDb(":memory:");
    await run(
      db,
      Effect.flatMap(SettingsService, (s) =>
        s.updateSettings({ aiAgent: "codex", jev: { enabled: true } }),
      ),
    );
    const reloaded = await run(
      db,
      Effect.flatMap(SettingsService, (s) => s.getSettings()),
    );
    expect(reloaded.aiAgent).toBe("codex");
    expect(reloaded.aiModel).toBe(getAgentCapabilities("codex").defaultModel);
    expect(reloaded.jev).toEqual({ enabled: true, hasApiKey: false });
  });

  it("keeps both of two concurrent patches, in memory and in the row", async () => {
    const db = createDb(":memory:");
    const inMemory = await run(
      db,
      Effect.gen(function* () {
        const s = yield* SettingsService;
        yield* Effect.all(
          [
            s.updateSettings({ diffViewMode: "split" }),
            s.updateSettings({ autoFetchInterval: 10 }),
          ],
          { concurrency: "unbounded" },
        );
        return yield* s.getSettings();
      }),
    );
    const reloaded = await run(
      db,
      Effect.flatMap(SettingsService, (s) => s.getSettings()),
    );
    for (const s of [inMemory, reloaded]) {
      expect([s.diffViewMode, s.autoFetchInterval]).toEqual(["split", 10]);
    }
  });

  it("resolves a valid agent from a row naming one that no longer exists", async () => {
    const db = createDb(":memory:");
    await run(
      db,
      Effect.flatMap(SettingsService, (s) => s.getSettings()),
    );
    db.update(userSettings).set({ aiAgent: "retired", recapAgent: "retired" }).run();
    const agents = await run(
      db,
      Effect.gen(function* () {
        const s = yield* SettingsService;
        return [yield* s.resolveAgent(), yield* s.resolveRecapAgent()];
      }),
    );
    expect(agents).toEqual([DEFAULT_USER_SETTINGS.aiAgent, DEFAULT_USER_SETTINGS.aiAgent]);
  });

  it("watch emits only when the selected value changes", async () => {
    const db = createDb(":memory:");
    const seen = await run(
      db,
      Effect.gen(function* () {
        const s = yield* SettingsService;
        const fiber = yield* s
          .watch((v) => v.autoFetchInterval)
          .pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);
        yield* Effect.yieldNow;
        yield* s.updateSettings({ diffViewMode: "split" });
        yield* s.updateSettings({ autoFetchInterval: 10 });
        yield* s.updateSettings({ diffViewMode: "unified" });
        yield* s.updateSettings({ autoFetchInterval: 0 });
        return yield* Fiber.join(fiber);
      }),
    );
    expect(Array.from(seen)).toEqual([10, 0]);
  });
});
