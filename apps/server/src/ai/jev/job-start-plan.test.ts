import { describe, expect, it } from "bun:test";
import type { JobStartAnswers } from "./job-start";
import { buildJobStartPlan, shouldResolveJobStart } from "./job-start-plan";

const settings = { aiModel: "revv:auto", aiThinkingEffort: "revv:auto" } as const;

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
  it("runs on a user trigger", () => {
    expect(shouldResolveJobStart({ trigger: "user", cacheWillHit: false })).toBe(true);
  });

  it("skips on resume, or on a cache hit", () => {
    expect(shouldResolveJobStart({ trigger: "resume", cacheWillHit: false })).toBe(false);
    expect(shouldResolveJobStart({ trigger: "user", cacheWillHit: true })).toBe(false);
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
