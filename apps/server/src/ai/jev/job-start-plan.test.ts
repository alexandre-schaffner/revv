import { describe, expect, it } from "bun:test";
import { DEFAULT_JEV_SETTINGS } from "@revv/shared";
import type { JobStartAnswers } from "./job-start";
import { buildJobStartPlan, shouldResolveJobStart } from "./job-start-plan";

const settings = {
  aiModel: "revv:auto",
  aiThinkingEffort: "revv:auto",
  jev: { ...DEFAULT_JEV_SETTINGS, enabled: true },
} as const;

const answers: JobStartAnswers = {
  riskLevel: "high",
  riskConfidence: 0.9,
  depth: "deep",
  depthConfidence: 0.9,
  depthProbabilities: { deep: 0.9 },
  reasoningEffort: "thorough",
  filePriorities: { "a.ts": 4 },
  splitScore: 0,
};

describe("job-start plan", () => {
  it("runs on a user trigger when TypeSafe is on", () => {
    expect(shouldResolveJobStart({ settings, trigger: "user", cacheWillHit: false })).toBe(true);
  });

  it("skips when TypeSafe is off, on resume, or on a cache hit", () => {
    const off = { ...settings, jev: DEFAULT_JEV_SETTINGS };
    expect(shouldResolveJobStart({ settings: off, trigger: "user", cacheWillHit: false })).toBe(
      false,
    );
    expect(shouldResolveJobStart({ settings, trigger: "resume", cacheWillHit: false })).toBe(false);
    expect(shouldResolveJobStart({ settings, trigger: "user", cacheWillHit: true })).toBe(false);
  });

  it("projects one answer into risk, routing and file priority", () => {
    const plan = buildJobStartPlan({
      settings,
      agent: "claude-code",
      files: [{ filename: "a.ts" }],
      answers,
    });
    expect(plan.assignedRisk).toBe("high");
    expect(plan.filePriorities).toEqual([{ filename: "a.ts", tier: 4 }]);
    expect(plan.launchOverride?.thinkingEffort).toBe("high");
  });
});
