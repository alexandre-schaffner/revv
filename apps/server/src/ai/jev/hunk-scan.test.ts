import { describe, expect, it } from "bun:test";
import type { HunkScanRow, HunkSmell } from "@revv/shared";
import {
  HUNK_SCAN_LEADS_PER_SMELL,
  HUNK_SCAN_MAX_LEADS,
  hunkContentHash,
  hunkScanLeads,
  isTestPath,
  selectHunks,
} from "./hunk-scan";
import type { FileLike } from "./state";

/** A patch with `count` one-line hunks, each adding `line`. */
function patchOf(count: number, line = "const x = 1;"): string {
  return Array.from(
    { length: count },
    (_, i) => `@@ -${i * 10 + 1},1 +${i * 10 + 1},2 @@\n ctx\n+${line}`,
  ).join("\n");
}

function file(filename: string, patch: string | null): FileLike {
  return { filename, status: "modified", additions: 1, deletions: 0, patch };
}

const QUIET: Record<HunkSmell, number> = {
  vulnerability: 0,
  over_defensive: 0,
  silent_failure: 0,
  slop: 0,
  over_engineered: 0,
  hard_to_read: 0,
  unclean: 0,
  verbose_comment: 0,
  redundant_test: 0,
};

function row(
  filePath: string,
  newStart: number,
  signals: Partial<Record<HunkSmell, number>> | null,
): HunkScanRow {
  return {
    filePath,
    hunkIndex: 0,
    oldStart: newStart,
    oldLines: 1,
    newStart,
    newLines: 3,
    skipReason: null,
    signals: signals === null ? null : { ...QUIET, ...signals },
    scannedAt: null,
  };
}

describe("selectHunks", () => {
  it("records skipped hunks with a reason and targets only the rest", () => {
    const { seeds, targets } = selectHunks(
      [
        file("bun.lock", patchOf(2)),
        file("src/deleted.ts", "@@ -1,2 +1,1 @@\n ctx\n-gone\n+\n"),
        file("logo.png", null),
        file("src/a.ts", patchOf(1)),
      ],
      new Map([
        ["bun.lock", 0],
        ["src/a.ts", 3],
      ]),
    );
    expect(seeds.map((s) => [s.filePath, s.hunkIndex, s.skipReason])).toEqual([
      ["bun.lock", 0, "generated"],
      ["bun.lock", 1, "generated"],
      // Adds only a blank line: nothing for the questions to judge.
      ["src/deleted.ts", 0, "deletion_only"],
      ["logo.png", 0, "no_patch"],
      ["src/a.ts", 0, null],
    ]);
    expect(targets.map((t) => t.filePath)).toEqual(["src/a.ts"]);
  });

  it("targets every hunk, highest tier first, keeping seeds in diff order", () => {
    const { seeds, targets } = selectHunks(
      [file("src/routine.ts", patchOf(500)), file("src/auth.ts", patchOf(5))],
      new Map([
        ["src/routine.ts", 2],
        ["src/auth.ts", 4],
      ]),
    );
    expect(targets).toHaveLength(505);
    expect(seeds.every((s) => s.skipReason === null)).toBe(true);
    // Most important first, so if Jev stops answering, what's missing is routine code.
    expect(targets.slice(0, 5).every((t) => t.filePath === "src/auth.ts")).toBe(true);
    expect(seeds[0]?.filePath).toBe("src/routine.ts");
  });

  it("sinks unscored files below scored ones and keeps diff order without priorities", () => {
    const files = [file("src/b.ts", patchOf(1)), file("src/a.ts", patchOf(1))];
    const unranked = selectHunks(files, null);
    expect(unranked.targets.map((t) => t.filePath)).toEqual(["src/b.ts", "src/a.ts"]);
    const ranked = selectHunks(files, new Map([["src/a.ts", 1]]));
    expect(ranked.targets.map((t) => t.filePath)).toEqual(["src/a.ts", "src/b.ts"]);
  });
});

describe("hunkContentHash", () => {
  it("depends on the content alone, so a hunk keeps its key across commits", () => {
    const body = "@@ -1,1 +1,2 @@\n ctx\n+x";
    expect(hunkContentHash("a.ts", "modified", body)).toBe(
      hunkContentHash("a.ts", "modified", body),
    );
    expect(hunkContentHash("a.ts", "modified", body)).not.toBe(
      hunkContentHash("b.ts", "modified", body),
    );
    expect(hunkContentHash("a.ts", "modified", body)).not.toBe(
      hunkContentHash("a.ts", "modified", `${body}\n+y`),
    );
  });

  it("is what the selector stores, so a resume can check it", () => {
    const patch = patchOf(1);
    const { seeds } = selectHunks([file("a.ts", patch)], null);
    expect(seeds[0]?.contentHash).toBe(hunkContentHash("a.ts", "modified", patch));
  });
});

describe("hunkScanLeads", () => {
  const allFiles = (rows: readonly HunkScanRow[]) => new Set(rows.map((r) => r.filePath));

  it("keeps only smells at or above their floor, strongest hunk first", () => {
    const rows = [
      row("a.ts", 1, { slop: 0.59 }),
      row("b.ts", 10, { slop: 0.72, unclean: 0.71 }),
      // vulnerability's floor is lower than the rest.
      row("c.ts", 20, { vulnerability: 0.55 }),
      row("d.ts", 30, { over_engineered: 0.9 }),
      row("e.ts", 40, null),
    ];
    const leads = hunkScanLeads(rows, allFiles(rows));
    expect(leads.map((l) => l.filePath)).toEqual(["d.ts", "b.ts", "c.ts"]);
    expect(leads[1]?.smells.map((s) => s.smell)).toEqual(["slop", "unclean"]);
  });

  it("caps the list", () => {
    const rows = Array.from({ length: HUNK_SCAN_MAX_LEADS + 5 }, (_, i) =>
      row(`f${i}.ts`, 1, { slop: 0.61 + i / 1000 }),
    );
    const leads = hunkScanLeads(rows, allFiles(rows));
    expect(leads).toHaveLength(HUNK_SCAN_MAX_LEADS);
    expect(leads[0]?.filePath).toBe(`f${HUNK_SCAN_MAX_LEADS + 4}.ts`);
  });

  it("keeps each smell's strongest leads when stronger smells would fill the cap", () => {
    const rows = [
      ...Array.from({ length: HUNK_SCAN_MAX_LEADS + 10 }, (_, i) =>
        row(`s${i}.ts`, 1, { silent_failure: 0.8 + i / 1000 }),
      ),
      ...Array.from({ length: HUNK_SCAN_LEADS_PER_SMELL + 2 }, (_, i) =>
        row(`c${i}.ts`, 1, { verbose_comment: 0.66 + i / 100 }),
      ),
    ];
    const leads = hunkScanLeads(rows, allFiles(rows));
    expect(leads).toHaveLength(HUNK_SCAN_MAX_LEADS);
    const comments = leads.filter((l) => l.smells.some((s) => s.smell === "verbose_comment"));
    expect(comments.map((l) => l.filePath)).toEqual(["c4.ts", "c3.ts", "c2.ts"]);
    // Still strongest first overall: the reserved leads sort below the rest.
    expect(leads.at(-1)?.filePath).toBe("c2.ts");
  });

  it("narrows an incremental review to the files it covers", () => {
    const leads = hunkScanLeads(
      [row("old.ts", 1, { slop: 0.9 }), row("new.ts", 1, { slop: 0.8 })],
      new Set(["new.ts"]),
    );
    expect(leads.map((l) => l.filePath)).toEqual(["new.ts"]);
  });
});

describe("isTestPath", () => {
  it("recognises the common test-file conventions", () => {
    for (const path of [
      "src/services/Cache.test.ts",
      "apps/web/src/lib/x.spec.tsx",
      "src/__tests__/util.js",
      "tests/integration/api.py",
      "pkg/server/handler_test.go",
      "app/test_models.py",
      "src/main/java/FooTest.java",
      "e2e/login.ts",
    ]) {
      expect(isTestPath(path)).toBe(true);
    }
  });

  it("leaves source files alone, including ones named after tests", () => {
    for (const path of [
      "src/services/Cache.ts",
      "src/ai/jev/testing-helpers.ts",
      "src/contest.ts",
      "docs/testing.md",
    ]) {
      expect(isTestPath(path)).toBe(false);
    }
  });
});
