import { describe, expect, it } from "bun:test";
import type { ProposedDiffFile } from "./api";
import { proposedFiles } from "./proposed-diff";

function file(over: Partial<ProposedDiffFile>): ProposedDiffFile {
  return {
    path: "src/a.ts",
    oldPath: null,
    oldContent: "a\n",
    newContent: "b\n",
    status: "M",
    binary: false,
    ...over,
  };
}

describe("proposedFiles", () => {
  it("lists a rename with no content change", () => {
    const [entry, ...rest] = proposedFiles("abc", [
      file({
        path: "src/new.ts",
        oldPath: "src/old.ts",
        oldContent: "x\n",
        newContent: "x\n",
        status: "R100",
      }),
    ]);
    expect(rest).toEqual([]);
    expect(entry?.status).toBe("renamed");
    expect(entry?.diff?.type).toBe("rename-pure");
    expect(entry?.diff?.name).toBe("src/new.ts");
    expect(entry?.diff?.prevName).toBe("src/old.ts");
    expect(entry?.diff?.hunks).toEqual([]);
  });

  it("builds whole-file diffs, so context around a hunk can expand", () => {
    const [entry] = proposedFiles("abc", [file({})]);
    expect(entry?.status).toBe("modified");
    expect(entry?.diff?.type).toBe("change");
    expect(entry?.diff?.isPartial).toBe(false);
  });

  it("takes the change kind from git's status", () => {
    const statuses = proposedFiles("abc", [
      file({ path: "added.ts", status: "A", oldContent: null }),
      file({ path: "gone.ts", status: "D", newContent: null }),
    ]).map((f) => [f.path, f.status]);
    expect(statuses).toEqual([
      ["added.ts", "added"],
      ["gone.ts", "deleted"],
    ]);
  });

  it("keeps a binary file, with no diff", () => {
    expect(
      proposedFiles("abc", [
        file({ path: "logo.png", status: "A", binary: true, oldContent: null, newContent: null }),
      ]),
    ).toEqual([{ path: "logo.png", status: "added", diff: null }]);
  });
});
