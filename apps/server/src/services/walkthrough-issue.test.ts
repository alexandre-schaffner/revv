import { describe, expect, it } from "bun:test";
import { isSameResolvedFinding, type RegeneratedIssueIdentity } from "./walkthrough-issue";

const finding: RegeneratedIssueIdentity = {
  severity: "warning",
  title: "Retry failures",
  description: "The request is not retried.",
  filePath: "src/request.ts",
  startLine: 12,
  endLine: 14,
};

describe("regenerated issue resolution carry-forward", () => {
  it("preserves resolution for the exact same finding", () => {
    expect(isSameResolvedFinding({ ...finding, resolutionStatus: "addressed" }, finding)).toBe(
      true,
    );
  });

  it("reopens changed or previously open findings", () => {
    expect(isSameResolvedFinding({ ...finding, resolutionStatus: "open" }, finding)).toBe(false);
    expect(
      isSameResolvedFinding(
        { ...finding, resolutionStatus: "addressed" },
        { ...finding, description: "The retry still misses timeouts." },
      ),
    ).toBe(false);
  });
});
