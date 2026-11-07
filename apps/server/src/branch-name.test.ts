import { describe, expect, it } from "bun:test";
import { isValidBranchName } from "@revv/shared";

describe("isValidBranchName", () => {
  it("accepts an ordinary branch name, ignoring surrounding space", () => {
    expect(isValidBranchName("feature/agent-changes")).toBe(true);
    expect(isValidBranchName("  fix-123  ")).toBe(true);
  });

  it("refuses what the push refuses", () => {
    expect(isValidBranchName("")).toBe(false);
    expect(isValidBranchName("   ")).toBe(false);
    expect(isValidBranchName("two words")).toBe(false);
    expect(isValidBranchName("a..b")).toBe(false);
    expect(isValidBranchName("-force")).toBe(false);
  });
});
