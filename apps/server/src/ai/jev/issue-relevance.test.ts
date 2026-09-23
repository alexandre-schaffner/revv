import { describe, expect, it } from "bun:test";
import { isDiscardedScore, isLowSignalScore, LOW_SIGNAL_THRESHOLD } from "@revv/shared";
import { compositeScore, severityForLevel } from "./issue-relevance-policy";

/** A concern that failed every judgment — the clearest discard case. */
const worthless = {
  grounded: 0.05,
  in_scope: 0.05,
  actionable: 0.05,
  novel: 0.05,
  severity: 0,
  declaredSeverity: "info",
};

/** A concern that passed every judgment. */
const solid = {
  grounded: 0.95,
  in_scope: 0.95,
  actionable: 0.9,
  novel: 0.9,
  severity: 2,
  declaredSeverity: "warning",
};

describe("compositeScore", () => {
  it("discards a concern that failed every judgment", () => {
    expect(isDiscardedScore(compositeScore(worthless))).toBe(true);
  });

  it("keeps and shows a concern that passed every judgment", () => {
    const score = compositeScore(solid);
    expect(isDiscardedScore(score)).toBe(false);
    expect(isLowSignalScore(score)).toBe(false);
  });

  // The severity floor puts the entire severe end of the distribution out of the
  // gate's reach, so no combination of soft judgments can drop it.
  it("never discards or hides a concern the agent called critical", () => {
    const score = compositeScore({ ...worthless, declaredSeverity: "critical" });
    expect(score).toBe(1);
    expect(isDiscardedScore(score)).toBe(false);
    expect(isLowSignalScore(score)).toBe(false);
  });

  it("never discards or hides a concern judged must-fix", () => {
    const score = compositeScore({ ...worthless, severity: 3 });
    expect(score).toBe(1);
    expect(isDiscardedScore(score)).toBe(false);
  });

  it("leaves a low-but-not-worthless concern in the collapsible band", () => {
    // Half-grounded, half in scope, says little the diff doesn't: worth collapsing, not deleting.
    const score = compositeScore({
      grounded: 0.5,
      in_scope: 0.5,
      actionable: 0.1,
      novel: 0.05,
      severity: 0,
      declaredSeverity: "info",
    });
    expect(isDiscardedScore(score)).toBe(false);
    expect(isLowSignalScore(score)).toBe(true);
  });

  // A ladder, not alternatives: a score can only be discarded if it would
  // also have been collapsed.
  it("keeps the discard floor strictly below the low-signal threshold", () => {
    for (let score = 0; score <= 1; score += 0.01) {
      if (isDiscardedScore(score)) expect(isLowSignalScore(score)).toBe(true);
    }
    expect(isDiscardedScore(LOW_SIGNAL_THRESHOLD)).toBe(false);
  });
});

describe("severityForLevel", () => {
  it("reads the rubric literally", () => {
    expect(severityForLevel(0)).toBe("info");
    expect(severityForLevel(1)).toBe("info");
    expect(severityForLevel(2)).toBe("warning");
    expect(severityForLevel(3)).toBe("critical");
  });

  // Continuous over the ordered levels: 1.6 is a weak "should fix", not a
  // strong "worth knowing".
  it("rounds a fractional level to the nearer tier", () => {
    expect(severityForLevel(1.4)).toBe("info");
    expect(severityForLevel(1.6)).toBe("warning");
    expect(severityForLevel(2.6)).toBe("critical");
  });

  it("clamps outside the rubric rather than returning undefined", () => {
    expect(severityForLevel(-1)).toBe("info");
    expect(severityForLevel(99)).toBe("critical");
  });
});
