import { describe, expect, it } from "bun:test";
import { parseMergeTree } from "./merge-tree";

const TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

describe("parseMergeTree", () => {
  it("reads a clean merge", () => {
    expect(parseMergeTree(0, `${TREE}\0`)).toEqual({ kind: "clean", tree: TREE });
  });

  it("lists each conflicted path once, spaces and unicode intact", () => {
    expect(parseMergeTree(1, `${TREE}\0a b.ts\0é.md\0a b.ts\0\0`)).toEqual({
      kind: "conflicts",
      tree: TREE,
      files: ["a b.ts", "é.md"],
    });
  });

  it("fails on any other exit code, naming git's complaint", () => {
    expect(parseMergeTree(128, "", "\nfatal: refusing to merge unrelated histories\n")).toEqual({
      kind: "failed",
      message: "fatal: refusing to merge unrelated histories",
    });
  });

  it("fails when no tree came back", () => {
    expect(parseMergeTree(0, "").kind).toBe("failed");
  });
});
