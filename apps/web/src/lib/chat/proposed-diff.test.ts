import { describe, expect, it } from "bun:test";
import type { ProposedDiffFile } from "./api";
import { proposedFileDiffs } from "./proposed-diff";

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

describe("proposedFileDiffs", () => {
  it("lists a rename with no content change", () => {
    const [diff, ...rest] = proposedFileDiffs("abc", [
      file({ path: "src/new.ts", oldPath: "src/old.ts", oldContent: "x\n", newContent: "x\n" }),
    ]);
    expect(rest).toEqual([]);
    expect(diff?.type).toBe("rename-pure");
    expect(diff?.name).toBe("src/new.ts");
    expect(diff?.prevName).toBe("src/old.ts");
    expect(diff?.hunks).toEqual([]);
  });

  it("builds whole-file diffs, so context around a hunk can expand", () => {
    const [diff] = proposedFileDiffs("abc", [file({})]);
    expect(diff?.type).toBe("change");
    expect(diff?.isPartial).toBe(false);
  });

  it("leaves binary files out", () => {
    expect(
      proposedFileDiffs("abc", [file({ binary: true, oldContent: null, newContent: null })]),
    ).toEqual([]);
  });
});
