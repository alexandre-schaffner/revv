import { describe, expect, test } from "bun:test";
import { extractLogTail } from "./log-tail";

const ts = (n: number) => `2026-10-12T09:00:${String(n).padStart(2, "0")}.1234567Z `;

const JOB_LOG = [
  `\uFEFF${ts(0)}##[group]Set up job`,
  `${ts(1)}Runner version 2.300`,
  `${ts(2)}##[endgroup]`,
  `${ts(3)}##[group]Run actions/checkout@v4`,
  `${ts(4)}Fetching the repository`,
  `${ts(5)}##[endgroup]`,
  `${ts(6)}##[group]Run bun test`,
  `${ts(7)}bun test`,
  `${ts(8)}##[endgroup]`,
  `${ts(9)}\x1b[32m✓\x1b[0m passes`,
  `${ts(10)}\x1b[31m✗\x1b[0m fails`,
  `${ts(11)}##[error]Process completed with exit code 1.`,
  `${ts(12)}##[group]Post actions/checkout@v4`,
  `${ts(13)}cleanup`,
  `${ts(14)}##[endgroup]`,
  "",
].join("\n");

describe("extractLogTail", () => {
  test("isolates the failing step and strips timestamps and ANSI", () => {
    const tail = extractLogTail(JOB_LOG);
    expect(tail.stepName).toBe("Run bun test");
    expect(tail.truncated).toBe(false);
    expect(tail.lines).toEqual([
      { kind: "group", text: "Run bun test" },
      { kind: "plain", text: "bun test" },
      { kind: "plain", text: "✓ passes" },
      { kind: "plain", text: "✗ fails" },
      { kind: "error", text: "Process completed with exit code 1." },
    ]);
  });

  test("stops at the post-job cleanup", () => {
    const log = [
      "##[group]Run bun run lint",
      "lint output",
      "##[error]Process completed with exit code 1.",
      "Post job cleanup.",
      "[command]/usr/bin/git version",
    ].join("\n");
    expect(extractLogTail(log).lines.map((l) => l.text)).toEqual([
      "Run bun run lint",
      "lint output",
      "Process completed with exit code 1.",
    ]);
  });

  test("keeps the end of a long step, where the error is", () => {
    const noise = Array.from({ length: 400 }, (_, i) => `line ${i}`);
    const log = ["##[group]Run make", ...noise, "##[error]boom"].join("\n");
    const tail = extractLogTail(log);
    expect(tail.truncated).toBe(true);
    expect(tail.lines).toHaveLength(150);
    expect(tail.lines.at(-1)).toEqual({ kind: "error", text: "boom" });
  });

  test("falls back to the log's tail when nothing is marked as an error", () => {
    const tail = extractLogTail("one\n##[warning]careful\ntwo\n");
    expect(tail.stepName).toBeNull();
    expect(tail.lines).toEqual([
      { kind: "plain", text: "one" },
      { kind: "warning", text: "careful" },
      { kind: "plain", text: "two" },
    ]);
  });
});
