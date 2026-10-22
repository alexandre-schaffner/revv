import { describe, expect, test } from "bun:test";
import { changedFiles, fingerprintFiles, isComparable, stackSignature } from "./fingerprint";

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

  test("a file without a patch never matches and makes the layer incomparable", () => {
    const binary = [{ filename: "img.png", status: "modified", patch: null }];
    const fp = fingerprintFiles(binary);
    expect(isComparable(fp)).toBe(false);
    expect(changedFiles(fp, fingerprintFiles(binary))).toEqual(["img.png"]);
  });
});

describe("stackSignature", () => {
  const base = { number: 1, headSha: "a", status: "merged" };
  const middle = { number: 2, headSha: "b", status: "ready" };
  const top = { number: 3, headSha: "c", status: "draft" };
  const layers = [base, middle, top];

  test("ignores merged layers and moves with any open head", () => {
    expect(stackSignature(layers)).toBe(stackSignature([{ ...base, headSha: "z" }, middle, top]));
    expect(stackSignature(layers)).not.toBe(
      stackSignature([base, middle, { ...top, headSha: "d" }]),
    );
  });
});
