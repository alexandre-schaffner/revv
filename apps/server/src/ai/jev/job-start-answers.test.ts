import { describe, expect, it } from "bun:test";
import {
  filePriorityOrder,
  type JobStartAnswers,
  SPLIT_RECOMMENDATION_FLOOR,
  splitRecommendation,
} from "./job-start";
import { scoreAnswerAt } from "./questions";

function answers(over: Partial<JobStartAnswers> = {}): JobStartAnswers {
  return {
    riskLevel: "medium",
    riskConfidence: 0.9,
    depth: "standard",
    depthConfidence: 0.9,
    depthProbabilities: { shallow: 0.05, standard: 0.9, deep: 0.05 },
    reasoningEffort: "standard",
    ...over,
  };
}

const files = [
  { filename: "bun.lock" },
  { filename: "src/auth/session.ts" },
  { filename: "README.md" },
  { filename: "src/util/format.ts" },
];

describe("filePriorityOrder", () => {
  it("is null when the hook never ran, so callers fall back to diff order", () => {
    expect(filePriorityOrder(answers(), files)).toBeNull();
    expect(filePriorityOrder(answers({ filePriorities: {} }), files)).toBeNull();
  });

  it("ranks highest attention first", () => {
    const ranked = filePriorityOrder(
      answers({
        filePriorities: {
          "bun.lock": 0,
          "src/auth/session.ts": 4,
          "README.md": 1,
          "src/util/format.ts": 2,
        },
      }),
      files,
    );
    expect(ranked?.map((f) => f.filename)).toEqual([
      "src/auth/session.ts",
      "src/util/format.ts",
      "README.md",
      "bun.lock",
    ]);
  });

  // An unjudged file isn't evidence of importance; sorting it to the top would be untrustworthy.
  it("sinks files past the scoring cap to the bottom, not the top", () => {
    const ranked = filePriorityOrder(answers({ filePriorities: { "README.md": 1 } }), files);
    expect(ranked?.[0]?.filename).toBe("README.md");
    expect(ranked?.slice(1).every((f) => f.tier === null)).toBe(true);
  });

  it("keeps diff order among equally-scored files", () => {
    const ranked = filePriorityOrder(
      answers({ filePriorities: { "bun.lock": 2, "src/auth/session.ts": 2, "README.md": 2 } }),
      files,
    );
    expect(ranked?.slice(0, 3).map((f) => f.filename)).toEqual([
      "bun.lock",
      "src/auth/session.ts",
      "README.md",
    ]);
  });
});

describe("splitRecommendation", () => {
  it("stays silent below the floor", () => {
    expect(splitRecommendation(answers())).toBeNull();
    expect(
      splitRecommendation(answers({ splitScore: SPLIT_RECOMMENDATION_FLOOR - 0.01 })),
    ).toBeNull();
  });

  it("names a piece count once it clears the floor", () => {
    expect(splitRecommendation(answers({ splitScore: 0.9, splitCount: "two" }))?.pieces).toBe(2);
    expect(splitRecommendation(answers({ splitScore: 0.9, splitCount: "three" }))?.pieces).toBe(3);
    expect(splitRecommendation(answers({ splitScore: 0.9, splitCount: "many" }))?.pieces).toBe(4);
  });

  it("keeps the floor high enough that a coin flip never recommends a split", () => {
    expect(SPLIT_RECOMMENDATION_FLOOR).toBeGreaterThan(0.5);
    expect(splitRecommendation(answers({ splitScore: 0.5, splitCount: "many" }))).toBeNull();
  });
});

describe("scoreAnswerAt", () => {
  it("reads dynamic SDK score answers without trusting their shape", () => {
    expect(scoreAnswerAt({ file_0: { score: 3 } }, "file_0")).toBe(3);
    expect(scoreAnswerAt({ file_0: { score: "3" } }, "file_0")).toBeNull();
    expect(scoreAnswerAt({}, "file_0")).toBeNull();
  });
});
