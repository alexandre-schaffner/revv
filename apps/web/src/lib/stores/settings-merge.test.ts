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
    autoModel: false,
    risk: false,
    verdicts: true,
    issueScoring: true,
    issueSeverity: true,
    filePriority: true,
    artifactQuality: true,
    proseVoice: true,
    hideLowSignal: true,
    adjudicateContinuations: false,
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

  it("keeps the other jev flags when one is patched", () => {
    // The bug this guards: a top-level spread replaced `jev` wholesale, so
    // flipping `risk` read back as the master switch off, no API key, and
    // every other feature off — until the next full fetch.
    const next = mergeSettingsUpdate(CURRENT, { jev: { risk: true } });
    expect(next.jev).toEqual({ ...CURRENT.jev, risk: true });
  });

  it("keeps hasApiKey, which no client patch can carry", () => {
    const next = mergeSettingsUpdate(CURRENT, { jev: { enabled: false } });
    expect(next.jev.hasApiKey).toBe(true);
  });

  it("deep-merges cache.signing", () => {
    const next = mergeSettingsUpdate(CURRENT, { cache: { signing: { mode: "off" } } });
    expect(next.cache.signing).toEqual({ ...CURRENT.cache.signing, mode: "off" });
    expect(next.cache.bucket).toBe("team-bucket");
  });

  // The generic guard. Adding a nested object to `UserSettings` and
  // forgetting to list it in `mergeSettingsUpdate` fails here rather than
  // shipping as "all my settings turned themselves off".
  it("deep-merges every nested object on UserSettings", () => {
    for (const [key, value] of Object.entries(CURRENT)) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
      const siblings = Object.entries(value);
      // Patch the first sub-field with a flipped/altered value and assert
      // the remaining sub-fields survive.
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
