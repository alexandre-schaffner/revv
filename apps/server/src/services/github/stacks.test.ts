import { describe, expect, test } from "bun:test";
import { stackStatus } from "./stacks";

describe("stackStatus", () => {
  test.each([
    ["MERGED", false, "UNKNOWN", "merged"],
    ["CLOSED", false, "CLEAN", "closed"],
    ["OPEN", true, "CLEAN", "draft"],
    ["OPEN", false, "CLEAN", "ready"],
    ["OPEN", false, "UNSTABLE", "ready"],
    ["OPEN", false, "BLOCKED", "not_ready"],
    ["OPEN", false, null, "not_ready"],
  ] as const)("%s draft=%s %s → %s", (state, isDraft, mergeStateStatus, status) => {
    expect(stackStatus({ state, isDraft, mergeStateStatus })).toBe(status);
  });
});
