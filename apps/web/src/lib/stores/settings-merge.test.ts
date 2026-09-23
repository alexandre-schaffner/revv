import { describe, expect, it } from "bun:test";
import { mergeSettingsUpdate, type SettingsUpdate, type UserSettings } from "@revv/shared";

const CURRENT: UserSettings = {
  id: "default",
  aiProvider: "anthropic",
  aiModel: "claude-sonnet-5",
  aiThinkingEffort: "medium",
  aiAgent: "claude-code",
  aiSuggestionsModel: "claude-haiku-4-5-20251001",
  aiMaxTurns: 60,
  theme: "dark",
  diffViewMode: "unified",
  autoFetchInterval: 300,
  githubHost: "github.com",
  githubClientId: "",
  recap: { enabled: true, dailyEnabled: true, weeklyEnabled: true, agent: "auto" },
  cache: {
    enabled: true,
    bucket: "team-bucket",
    uploadsEnabled: true,
    downloadsEnabled: true,
    signing: { mode: "strict", keyPath: "/k", trustedSignerHosts: ["github.com"] },
  },
  jev: {
    enabled: true,
    hasApiKey: true,
  },
  updateChannel: "stable",
};

describe("mergeSettingsUpdate", () => {
  it("applies a top-level scalar without touching anything else", () => {
    const next = mergeSettingsUpdate(CURRENT, { aiModel: "claude-opus-5" });
    expect(next.aiModel).toBe("claude-opus-5");
    expect(next.jev).toEqual(CURRENT.jev);
    expect(next.cache).toEqual(CURRENT.cache);
  });

  it("keeps hasApiKey, which no client patch can carry", () => {
    // Also guards against a top-level spread replacing `jev` wholesale.
    const next = mergeSettingsUpdate(CURRENT, { jev: { enabled: false } });
    expect(next.jev.hasApiKey).toBe(true);
  });

  it("deep-merges cache.signing", () => {
    const next = mergeSettingsUpdate(CURRENT, { cache: { signing: { mode: "off" } } });
    expect(next.cache.signing).toEqual({ ...CURRENT.cache.signing, mode: "off" });
    expect(next.cache.bucket).toBe("team-bucket");
  });

  // A nested object added to `UserSettings` but not to `mergeSettingsUpdate`
  // fails here rather than shipping as settings turning themselves off.
  it("deep-merges every nested object on UserSettings", () => {
    for (const [key, value] of Object.entries(CURRENT)) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
      const siblings = Object.entries(value);
      // Patch the first sub-field and assert the rest survive.
      const [firstKey, firstValue] = siblings[0] as [string, unknown];
      const patched = typeof firstValue === "boolean" ? !firstValue : firstValue;
      const next = mergeSettingsUpdate(CURRENT, {
        [key]: { [firstKey]: patched },
      } as SettingsUpdate);
      const merged = (next as unknown as Record<string, Record<string, unknown>>)[key];
      expect(merged).toBeDefined();
      for (const [siblingKey, siblingValue] of siblings.slice(1)) {
        expect({ key, siblingKey, got: merged?.[siblingKey] }).toEqual({
          key,
          siblingKey,
          got: siblingValue,
        });
      }
    }
  });
});
