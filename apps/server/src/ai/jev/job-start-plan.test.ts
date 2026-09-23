import { describe, expect, it } from "bun:test";
import { DEFAULT_JEV_SETTINGS } from "@revv/shared";
import type { JobStartAnswers } from "./job-start";
import { buildJobStartPlan, shouldResolveJobStart } from "./job-start-plan";

const settings = {
  aiModel: "revv:auto",
  aiThinkingEffort: "revv:auto",
  jev: { ...DEFAULT_JEV_SETTINGS, enabled: true, autoModel: true, filePriority: true },
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
  it("runs when file priority is the only enabled judgment hook", () => {
    const fileOnly = {
      ...settings,
      jev: { ...DEFAULT_JEV_SETTINGS, enabled: true, filePriority: true },
    };
    expect(
      shouldResolveJobStart({ settings: fileOnly, trigger: "user", cacheWillHit: false }),
    ).toBe(true);
  });

  it("projects one answer into routing and file priority without assigning disabled risk", () => {
    const plan = buildJobStartPlan({
      settings,
      agent: "claude-code",
      files: [{ filename: "a.ts" }],
      answers,
    });
    expect(plan.assignedRisk).toBeNull();
    expect(plan.filePriorities).toEqual([{ filename: "a.ts", tier: 4 }]);
    expect(plan.launchOverride?.thinkingEffort).toBe("high");
  });
});
