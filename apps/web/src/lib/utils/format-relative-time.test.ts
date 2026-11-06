import { describe, expect, it } from "bun:test";
import { formatRelativeTime } from "./format-relative-time";

const NOW = Date.parse("2026-11-06T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("formatRelativeTime", () => {
  it("folds the first 45 seconds into 'just now'", () => {
    expect(formatRelativeTime(ago(30_000), { now: NOW })).toBe("just now");
    expect(formatRelativeTime(ago(5 * 60_000), { now: NOW })).toBe("5m ago");
    expect(formatRelativeTime(ago(3 * 3_600_000), { now: NOW })).toBe("3h ago");
    expect(formatRelativeTime(ago(2 * 86_400_000), { now: NOW })).toBe("2d ago");
    expect(formatRelativeTime(ago(20 * 86_400_000), { now: NOW })).toBe("2026-10-17");
  });

  it("counts seconds under a minute when asked", () => {
    expect(formatRelativeTime(ago(4_000), { now: NOW, seconds: true })).toBe("just now");
    expect(formatRelativeTime(ago(12_000), { now: NOW, seconds: true })).toBe("12s ago");
    expect(formatRelativeTime(ago(59_900), { now: NOW, seconds: true })).toBe("59s ago");
    expect(formatRelativeTime(ago(60_000), { now: NOW, seconds: true })).toBe("1m ago");
  });

  it("returns unparseable input unchanged", () => {
    expect(formatRelativeTime("not a date")).toBe("not a date");
  });
});
