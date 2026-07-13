import { describe, expect, it } from "bun:test";
import {
  capPatch,
  countPatchLines,
  MAX_INCREMENTAL_PATCH_BYTES,
  normalizeGitStatus,
  parseNameStatusZ,
  parseNumstat,
} from "./incremental-diff";

// ── normalizeGitStatus ───────────────────────────────────────────────────────

describe("normalizeGitStatus", () => {
  it("maps the git status letters", () => {
    expect(normalizeGitStatus("A")).toBe("added");
    expect(normalizeGitStatus("D")).toBe("removed");
    expect(normalizeGitStatus("R100")).toBe("renamed");
    expect(normalizeGitStatus("C75")).toBe("copied");
    expect(normalizeGitStatus("T")).toBe("changed");
    expect(normalizeGitStatus("M")).toBe("modified");
  });

  it("defaults to modified for unknown/empty input", () => {
    expect(normalizeGitStatus("")).toBe("modified");
    expect(normalizeGitStatus("X")).toBe("modified");
  });
});

// ── parseNameStatusZ ─────────────────────────────────────────────────────────

describe("parseNameStatusZ", () => {
  it("parses plain modifications and additions", () => {
    const raw = "M\0src/a.ts\0A\0src/b.ts\0";
    expect(parseNameStatusZ(raw)).toEqual([
      { status: "M", filename: "src/a.ts", previousFilename: null },
      { status: "A", filename: "src/b.ts", previousFilename: null },
    ]);
  });

  it("captures pre-image path for renames and copies", () => {
    const raw = "R100\0old/name.ts\0new/name.ts\0C50\0src/base.ts\0src/copy.ts\0";
    expect(parseNameStatusZ(raw)).toEqual([
      { status: "R100", filename: "new/name.ts", previousFilename: "old/name.ts" },
      { status: "C50", filename: "src/copy.ts", previousFilename: "src/base.ts" },
    ]);
  });

  it("ignores trailing/empty tokens", () => {
    expect(parseNameStatusZ("")).toEqual([]);
    expect(parseNameStatusZ("\0\0")).toEqual([]);
  });
});

// ── parseNumstat ─────────────────────────────────────────────────────────────

describe("parseNumstat", () => {
  it("keys counts by path", () => {
    const counts = parseNumstat("12\t3\tsrc/a.ts\n0\t5\tsrc/b.ts\n");
    expect(counts.get("src/a.ts")).toEqual({ additions: 12, deletions: 3 });
    expect(counts.get("src/b.ts")).toEqual({ additions: 0, deletions: 5 });
  });

  it("treats binary files (-/-) as zero counts", () => {
    const counts = parseNumstat("-\t-\tassets/logo.png\n");
    expect(counts.get("assets/logo.png")).toEqual({ additions: 0, deletions: 0 });
  });

  it("preserves rename arrow notation as the raw key (caller falls back)", () => {
    const counts = parseNumstat("4\t2\tsrc/{old => new}.ts\n");
    expect(counts.get("src/{old => new}.ts")).toEqual({ additions: 4, deletions: 2 });
    // The resolved post-image path is NOT a hit — this is why the caller
    // falls back to countPatchLines for renamed files.
    expect(counts.get("src/new.ts")).toBeUndefined();
  });

  it("skips malformed lines", () => {
    const counts = parseNumstat("garbage\n12\t3\tsrc/a.ts\n\n");
    expect(counts.size).toBe(1);
    expect(counts.get("src/a.ts")).toEqual({ additions: 12, deletions: 3 });
  });
});

// ── countPatchLines ──────────────────────────────────────────────────────────

describe("countPatchLines", () => {
  it("counts added/removed lines and ignores file headers", () => {
    const patch = ["--- a/x.ts", "+++ b/x.ts", "@@ -1 +1,2 @@", "-old", "+new", "+extra"].join(
      "\n",
    );
    expect(countPatchLines(patch)).toEqual({ additions: 2, deletions: 1 });
  });
});

// ── capPatch ─────────────────────────────────────────────────────────────────

describe("capPatch", () => {
  it("returns null for empty or whitespace-only patches", () => {
    expect(capPatch("")).toBeNull();
    expect(capPatch("   \n\t ")).toBeNull();
  });

  it("returns small patches unchanged", () => {
    const patch = "@@ -1 +1 @@\n-a\n+b";
    expect(capPatch(patch)).toBe(patch);
  });

  it("returns a patch at exactly the cap unchanged", () => {
    const patch = "+".repeat(MAX_INCREMENTAL_PATCH_BYTES);
    expect(capPatch(patch)).toBe(patch);
  });

  it("truncates oversized patches with a marker", () => {
    const oversized = "+".repeat(MAX_INCREMENTAL_PATCH_BYTES + 5000);
    const result = capPatch(oversized);
    expect(result).not.toBeNull();
    expect(result?.startsWith("+".repeat(MAX_INCREMENTAL_PATCH_BYTES))).toBe(true);
    expect(result).toContain("diff truncated");
    expect(result).toContain(String(oversized.length));
    // The kept diff body never exceeds the cap (the marker is short metadata).
    expect(result?.length).toBeLessThan(MAX_INCREMENTAL_PATCH_BYTES + 200);
  });
});
