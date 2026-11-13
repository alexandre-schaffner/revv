import { describe, expect, test } from "bun:test";
import { changedFiles, fingerprintFiles } from "./restack";

describe("fingerprintFiles", () => {
  const a = { filename: "a.ts", status: "modified", patch: "@@ -1,2 +1,3 @@\n+x" };
  const b = { filename: "b.ts", status: "added", patch: "@@ -0,0 +1 @@\n+y" };
  const files = [a, b];

  test("identical changes fingerprint identically", () => {
    expect(changedFiles(fingerprintFiles(files), fingerprintFiles([...files].reverse()))).toEqual(
      [],
    );
  });

  test("a hunk that moved is a change, so anchors never drift", () => {
    const moved = [{ ...a, patch: "@@ -4,2 +4,3 @@\n+x" }, b];
    expect(changedFiles(fingerprintFiles(files), fingerprintFiles(moved))).toEqual(["a.ts"]);
  });

  test("added and removed files count as changed", () => {
    expect(changedFiles(fingerprintFiles(files), fingerprintFiles([a]))).toEqual(["b.ts"]);
  });

  test("a file without a patch never matches", () => {
    const binary = [{ filename: "img.png", status: "modified", patch: null }];
    expect(changedFiles(fingerprintFiles(binary), fingerprintFiles(binary))).toEqual(["img.png"]);
  });
});
