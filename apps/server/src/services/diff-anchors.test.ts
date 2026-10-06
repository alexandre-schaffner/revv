import { describe, expect, it } from "bun:test";
import { parsePatchFiles } from "@pierre/diffs";
import { buildGitPatchHeader } from "@revv/shared";
import { commentableLines, fitAnchorToPatch, splitHunks } from "./diff-anchors";

// Two hunks: new lines 10-13 and 30-32, old lines 10-12 and 30-33.
const PATCH = [
  "@@ -10,3 +10,4 @@ context header",
  " keep a",
  "-drop b",
  "+add b",
  "+add c",
  " keep d",
  "@@ -30,4 +30,3 @@ context header",
  " keep e",
  "-drop f",
  "-drop g",
  "+add h",
  " keep i",
  "",
].join("\n");

describe("commentableLines", () => {
  it("splits line numbers per hunk and side", () => {
    const hunks = commentableLines(PATCH);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]?.right).toEqual([10, 11, 12, 13]);
    expect(hunks[0]?.left).toEqual([10, 11, 12]);
    expect(hunks[1]?.right).toEqual([30, 31, 32]);
    expect(hunks[1]?.left).toEqual([30, 31, 32, 33]);
  });

  it("does not count the trailing newline as a context line", () => {
    const hunks = commentableLines("@@ -1,1 +1,1 @@\n one\n");
    expect(hunks[0]?.right).toEqual([1]);
  });

  it("ignores the no-newline marker", () => {
    const hunks = commentableLines("@@ -1,1 +1,2 @@\n one\n+two\n\\ No newline at end of file");
    expect(hunks[0]?.right).toEqual([1, 2]);
  });
});

describe("fitAnchorToPatch", () => {
  it("leaves an in-diff anchor alone", () => {
    expect(fitAnchorToPatch(PATCH, { startLine: 11, endLine: 12, side: "RIGHT" })).toEqual({
      ok: true,
      startLine: 11,
      endLine: 12,
    });
  });

  it("clamps an end line that runs past the hunk", () => {
    // The walkthrough agent reads whole files, so it flags ranges that spill
    // out of the hunk it started in — GitHub 422s the whole review for that.
    expect(fitAnchorToPatch(PATCH, { startLine: 12, endLine: 19, side: "RIGHT" })).toEqual({
      ok: true,
      startLine: 12,
      endLine: 13,
    });
  });

  it("clamps a start line that begins before the hunk", () => {
    expect(fitAnchorToPatch(PATCH, { startLine: 25, endLine: 31, side: "RIGHT" })).toEqual({
      ok: true,
      startLine: 30,
      endLine: 31,
    });
  });

  it("keeps the hunk holding the end line when the anchor spans two", () => {
    // GitHub hangs the comment off `line` (the end), so that end is the one
    // worth preserving — even though the first hunk overlaps by one more line.
    const fit = fitAnchorToPatch(PATCH, { startLine: 10, endLine: 32, side: "RIGHT" });
    expect(fit).toEqual({ ok: true, startLine: 30, endLine: 32 });
  });

  it("rejects an anchor that misses every hunk", () => {
    const fit = fitAnchorToPatch(PATCH, { startLine: 20, endLine: 20, side: "RIGHT" });
    expect(fit.ok).toBe(false);
    if (!fit.ok) expect(fit.reason).toContain("line 20");
  });

  it("reads a deleted line on the old side only", () => {
    // Old lines 31-32 were deleted, so they exist on LEFT. The same numbers on
    // RIGHT are a different pair of lines, and 33 exists on LEFT alone.
    expect(fitAnchorToPatch(PATCH, { startLine: 31, endLine: 33, side: "LEFT" })).toEqual({
      ok: true,
      startLine: 31,
      endLine: 33,
    });
    const fit = fitAnchorToPatch(PATCH, { startLine: 33, endLine: 33, side: "RIGHT" });
    expect(fit.ok).toBe(false);
  });

  it("passes an anchor through when the patch is unavailable", () => {
    expect(fitAnchorToPatch(null, { startLine: 900, endLine: 900, side: "RIGHT" })).toEqual({
      ok: true,
      startLine: 900,
      endLine: 900,
    });
  });
});

describe("splitHunks", () => {
  it("splits on every header and reads both ranges", () => {
    const hunks = splitHunks(PATCH);
    expect(hunks.map((h) => [h.index, h.oldStart, h.oldLines, h.newStart, h.newLines])).toEqual([
      [0, 10, 3, 10, 4],
      [1, 30, 4, 30, 3],
    ]);
    expect(hunks[0]?.addedLines).toEqual(["add b", "add c"]);
    expect(hunks[1]?.body.split("\n")[0]).toBe("@@ -30,4 +30,3 @@ context header");
    // The trailing newline doesn't leave an empty context line on the last hunk.
    expect(hunks[1]?.body.endsWith(" keep i")).toBe(true);
  });

  it("defaults an omitted count to 1 and keeps the no-newline marker out of added lines", () => {
    const [hunk] = splitHunks("@@ -7 +7 @@\n-old\n+new\n\\ No newline at end of file\n");
    expect(hunk).toMatchObject({ oldStart: 7, oldLines: 1, newStart: 7, newLines: 1 });
    expect(hunk?.addedLines).toEqual(["new"]);
  });

  it("drops the preamble before the first header", () => {
    const hunks = splitHunks(`diff --git a/x b/x\n--- a/x\n+++ b/x\n${PATCH}`);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]?.addedLines).toEqual(["add b", "add c"]);
  });

  it("returns no hunks for an empty patch", () => {
    expect(splitHunks("")).toEqual([]);
  });

  // The diff tab addresses hunks by Pierre's index; the scan rows must agree.
  it("indexes hunks the way @pierre/diffs does", () => {
    const patch = `${PATCH}@@ -50 +49,2 @@\n x\n+y\n\\ No newline at end of file\n`;
    const header = buildGitPatchHeader({ path: "src/a.ts" });
    const pierre = parsePatchFiles(`${header}\n${patch}`)[0]?.files[0]?.hunks ?? [];
    const ours = splitHunks(patch).map((h) => [h.newStart, h.newLines, h.oldStart, h.oldLines]);
    expect(ours).toEqual(
      pierre.map((h) => [h.additionStart, h.additionCount, h.deletionStart, h.deletionCount]),
    );
    expect(ours).toHaveLength(3);
  });
});
