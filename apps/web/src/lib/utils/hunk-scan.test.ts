import { describe, expect, it } from "bun:test";
import type { HunkScanRow, HunkSmell, WalkthroughIssue, WalkthroughLead } from "@revv/shared";
import {
  firstPassView,
  hunkRangeLabel,
  hunkTone,
  leadOutcome,
  overlappingIssueIds,
  patchHunkRanges,
  rowMatchesHunk,
  scanProgress,
  scanTicks,
} from "./hunk-scan";

function row(over: Partial<HunkScanRow> = {}): HunkScanRow {
  return {
    filePath: "src/a.ts",
    hunkIndex: 0,
    oldStart: 10,
    oldLines: 5,
    newStart: 10,
    newLines: 5,
    skipReason: null,
    signals: null,
    scannedAt: null,
    ...over,
  };
}

function issue(over: Partial<WalkthroughIssue> & { id: string }): WalkthroughIssue {
  return {
    severity: "warning",
    title: "t",
    description: "d",
    blockIds: [],
    filePath: "src/a.ts",
    ...over,
  };
}

function signals(over: Partial<Record<HunkSmell, number>> = {}): Record<HunkSmell, number> {
  return {
    vulnerability: 0,
    over_defensive: 0,
    silent_failure: 0,
    slop: 0,
    over_engineered: 0,
    hard_to_read: 0,
    unclean: 0,
    verbose_comment: 0,
    redundant_test: 0,
    ...over,
  };
}

// Hunk under test covers new-side lines 10..14, i.e. [10, 15).
describe("leadOutcome, untracked walkthrough", () => {
  it("confirms an issue inside the hunk", () => {
    const out = leadOutcome(row(), [issue({ id: "i", startLine: 12, endLine: 13 })], false, null);
    expect(out).toEqual({ kind: "confirmed", issueIds: ["i"] });
  });

  it("confirms an issue that touches the first line", () => {
    const out = leadOutcome(row(), [issue({ id: "i", startLine: 5, endLine: 10 })], true, null);
    expect(out.kind).toBe("confirmed");
  });

  it("confirms an issue that starts on the last line", () => {
    const out = leadOutcome(row(), [issue({ id: "i", startLine: 14, endLine: 20 })], true, null);
    expect(out.kind).toBe("confirmed");
  });

  it("does not confirm an issue that ends just before the hunk", () => {
    const out = leadOutcome(row(), [issue({ id: "i", startLine: 1, endLine: 9 })], true, null);
    expect(out).toEqual({ kind: "not_raised" });
  });

  it("does not confirm an issue that starts at the exclusive end", () => {
    const out = leadOutcome(row(), [issue({ id: "i", startLine: 15 })], true, null);
    expect(out).toEqual({ kind: "not_raised" });
  });

  it("treats a missing endLine as a one-line range", () => {
    expect(leadOutcome(row(), [issue({ id: "i", startLine: 10 })], true, null).kind).toBe(
      "confirmed",
    );
    expect(leadOutcome(row(), [issue({ id: "i", startLine: 9 })], true, null).kind).toBe(
      "not_raised",
    );
  });

  it("ignores issues on a different file", () => {
    const out = leadOutcome(
      row(),
      [issue({ id: "i", filePath: "src/b.ts", startLine: 12 })],
      true,
      null,
    );
    expect(out).toEqual({ kind: "not_raised" });
  });

  it("ignores issues without a start line", () => {
    expect(leadOutcome(row(), [issue({ id: "i" })], true, null)).toEqual({ kind: "not_raised" });
  });

  it("never confirms a hunk with no new-side lines", () => {
    const out = leadOutcome(row({ newLines: 0 }), [issue({ id: "i", startLine: 10 })], true, null);
    expect(out).toEqual({ kind: "not_raised" });
  });

  it("collects every overlapping issue", () => {
    const out = leadOutcome(
      row(),
      [
        issue({ id: "a", startLine: 10 }),
        issue({ id: "b", startLine: 30 }),
        issue({ id: "c", startLine: 11, endLine: 40 }),
      ],
      false,
      null,
    );
    expect(out).toEqual({ kind: "confirmed", issueIds: ["a", "c"] });
  });

  it("is pending while generation runs and nothing overlaps", () => {
    expect(leadOutcome(row(), [], false, null)).toEqual({ kind: "pending" });
  });
});

function lead(over: Partial<WalkthroughLead> = {}): WalkthroughLead {
  return {
    id: "L1",
    filePath: "src/a.ts",
    hunkIndex: 0,
    newStart: 10,
    newLines: 5,
    smells: [{ smell: "verbose_comment", probability: 0.7 }],
    verdict: null,
    issueId: null,
    reason: null,
    ...over,
  };
}

describe("leadOutcome, recorded leads", () => {
  it("confirms through the recorded link, not through overlap", () => {
    // The issue sits outside the hunk; the link is what counts.
    const issues = [issue({ id: "i", startLine: 80 })];
    const out = leadOutcome(row(), issues, true, [lead({ verdict: "confirmed", issueId: "i" })]);
    expect(out).toEqual({ kind: "confirmed", issueIds: ["i"] });
  });

  it("doesn't confirm on an overlapping issue the agent never linked", () => {
    const issues = [issue({ id: "i", startLine: 12 })];
    expect(leadOutcome(row(), issues, true, [lead()])).toEqual({ kind: "unchecked" });
    expect(leadOutcome(row(), issues, false, [lead()])).toEqual({ kind: "pending" });
  });

  it("reads a confirmation whose issue is gone as withdrawn", () => {
    expect(leadOutcome(row(), [], true, [lead({ verdict: "confirmed", issueId: "gone" })])).toEqual(
      { kind: "withdrawn" },
    );
    expect(leadOutcome(row(), [], true, [lead({ verdict: "confirmed" })])).toEqual({
      kind: "withdrawn",
    });
  });

  it("carries a rejection's reason", () => {
    const out = leadOutcome(row(), [], true, [
      lead({ verdict: "rejected", reason: "The caller validates it." }),
    ]);
    expect(out).toEqual({ kind: "rejected", reason: "The caller validates it." });
  });

  it("marks a flagged hunk the agent was never handed as not sent", () => {
    expect(leadOutcome(row({ hunkIndex: 3 }), [], false, [lead()])).toEqual({ kind: "not_sent" });
    expect(leadOutcome(row(), [], true, [])).toEqual({ kind: "not_sent" });
  });
});

describe("hunkTone", () => {
  it("is the worst flagged smell's tone, past the shared floors", () => {
    expect(hunkTone(row({ signals: signals({ slop: 0.7, unclean: 0.69 }) }))).toBe("warning");
    expect(hunkTone(row({ signals: signals({ slop: 0.9, vulnerability: 0.5 }) }))).toBe("danger");
  });

  it("is null when nothing is flagged or nothing answered", () => {
    expect(hunkTone(row({ signals: signals({ slop: 0.59 }) }))).toBeNull();
    expect(hunkTone(row())).toBeNull();
  });
});

describe("overlappingIssueIds", () => {
  it("keeps issues on the same file whose lines touch the hunk's new side", () => {
    const ids = overlappingIssueIds(row(), [
      issue({ id: "inside", startLine: 12 }),
      issue({ id: "straddles", startLine: 5, endLine: 10 }),
      issue({ id: "after", startLine: 15 }),
      issue({ id: "other-file", startLine: 12, filePath: "src/b.ts" }),
      issue({ id: "unplaced" }),
    ]);
    expect(ids).toEqual(["inside", "straddles"]);
  });
});

describe("patchHunkRanges / rowMatchesHunk", () => {
  const patch = ["@@ -1,3 +1,4 @@ fn a", " ctx", "+added", "@@ -40 +41 @@", "-old", "+new"].join(
    "\n",
  );

  it("reads each header's new side, an omitted count meaning one line", () => {
    expect(patchHunkRanges(patch)).toEqual([
      { newStart: 1, newLines: 4 },
      { newStart: 41, newLines: 1 },
    ]);
  });

  it("matches a row only to the hunk it was scanned from", () => {
    const [first, second] = patchHunkRanges(patch);
    if (!first || !second) throw new Error("expected two hunks");
    expect(rowMatchesHunk(row({ newStart: 1, newLines: 4 }), first)).toBe(true);
    expect(rowMatchesHunk(row({ newStart: 1, newLines: 4 }), second)).toBe(false);
    expect(rowMatchesHunk(row({ newStart: 41, newLines: 2 }), second)).toBe(false);
  });
});

describe("scanProgress", () => {
  it("counts answered rows against rows not skipped for content", () => {
    const out = scanProgress([
      row({ signals: signals() }),
      row({ hunkIndex: 1 }),
      row({ hunkIndex: 2, skipReason: "unscanned" }),
      row({ hunkIndex: 3, skipReason: "generated" }),
      row({ hunkIndex: 4, skipReason: "deletion_only" }),
    ]);
    expect(out).toEqual({ answered: 1, total: 3 });
  });
});

describe("hunkRangeLabel", () => {
  it("formats multi-line and one-line hunks", () => {
    expect(hunkRangeLabel(row({ newStart: 42, newLines: 27 }))).toBe("L42–68");
    expect(hunkRangeLabel(row({ newStart: 7, newLines: 1 }))).toBe("L7");
    expect(hunkRangeLabel(row({ newStart: 7, newLines: 0 }))).toBe("L7");
  });
});

describe("scanTicks", () => {
  const answered = (hunkIndex: number, over: Partial<Record<HunkSmell, number>> = {}) =>
    row({ hunkIndex, signals: signals(over), scannedAt: "t" });

  it("gives each hunk its own tick when there is room, leaving content skips out", () => {
    const ticks = scanTicks(
      [answered(0), row({ hunkIndex: 1 }), row({ hunkIndex: 2, skipReason: "generated" })],
      10,
    );
    expect(ticks.map((t) => t.state)).toEqual(["clean", "pending"]);
  });

  it("shares ticks past the limit and shows the worst hunk of each", () => {
    const rows = [
      answered(0),
      answered(1, { slop: 0.9 }),
      answered(2),
      answered(3, { vulnerability: 0.6 }),
      row({ hunkIndex: 4 }),
      row({ hunkIndex: 5, skipReason: "unscanned" }),
    ];
    const ticks = scanTicks(rows, 3);
    expect(ticks.map((t) => [t.state, t.hunks.length, t.share])).toEqual([
      ["warning", 2, 0.5],
      ["danger", 2, 0.5],
      ["pending", 2, 0],
    ]);
  });

  it("levels a clean hunk against its closest floor", () => {
    const [tick] = scanTicks([answered(0, { slop: 0.3, unclean: 0.35 })], 1);
    expect(tick?.level).toBeCloseTo(0.5);
  });

  it("keeps the rows' own (diff) order rather than regrouping by file", () => {
    const ticks = scanTicks(
      [answered(0, { slop: 0.9 }), row({ filePath: "src/b.ts", hunkIndex: 0 }), answered(1)],
      10,
    );
    expect(ticks.map((t) => t.state)).toEqual(["warning", "pending", "clean"]);
  });

  it("is empty when every hunk was skipped for content", () => {
    expect(scanTicks([row({ skipReason: "generated" })], 10)).toEqual([]);
  });
});

const review = (
  rows: HunkScanRow[],
  issues: WalkthroughIssue[],
  isComplete: boolean,
  leads: WalkthroughLead[] | null,
) => firstPassView(rows, "complete", issues, isComplete, leads);

describe("firstPassView: unraised leads", () => {
  it("keeps flagged hunks no issue overlaps, vulnerabilities first", () => {
    const rows = [
      row({ hunkIndex: 0, newStart: 10, signals: signals({ slop: 0.9 }) }),
      row({ hunkIndex: 1, newStart: 50, signals: signals({ vulnerability: 0.55 }) }),
      row({ hunkIndex: 2, newStart: 90, signals: signals({ slop: 0.95 }) }),
      row({ hunkIndex: 3, newStart: 130, signals: signals() }),
    ];
    const { unraised } = review(rows, [issue({ id: "a", startLine: 92 })], false, null);
    expect(unraised.map((l) => l.row.hunkIndex)).toEqual([1, 0]);
  });

  it("keeps every recorded lead that didn't become a live issue, with its outcome", () => {
    const rows = [
      row({ hunkIndex: 0, newStart: 10, signals: signals({ slop: 0.9 }) }),
      row({ hunkIndex: 1, newStart: 50, signals: signals({ slop: 0.8 }) }),
      row({ hunkIndex: 2, newStart: 90, signals: signals({ slop: 0.7 }) }),
    ];
    const { unraised } = review(rows, [issue({ id: "a", startLine: 10 })], true, [
      lead({ id: "L1", hunkIndex: 0, verdict: "confirmed", issueId: "a" }),
      lead({ id: "L2", hunkIndex: 1, verdict: "rejected", reason: "Guarded upstream." }),
    ]);
    expect(unraised.map((l) => [l.row.hunkIndex, l.outcome.kind])).toEqual([
      [1, "rejected"],
      [2, "not_sent"],
    ]);
  });
});

describe("firstPassView: smells by issue", () => {
  it("collects every smell on the hunks an issue overlaps, in canonical order", () => {
    const rows = [
      row({ hunkIndex: 0, newStart: 10, signals: signals({ slop: 0.9 }) }),
      row({ hunkIndex: 1, newStart: 20, signals: signals({ vulnerability: 0.6 }) }),
      row({ hunkIndex: 2, newStart: 90, signals: signals({ slop: 0.9 }) }),
    ];
    const { smellsByIssue, unraised } = review(
      rows,
      [issue({ id: "a", startLine: 12, endLine: 22 })],
      false,
      null,
    );
    expect(smellsByIssue.get("a")).toEqual(["vulnerability", "slop"]);
    expect(smellsByIssue.size).toBe(1);
    expect(unraised.map((l) => l.row.hunkIndex)).toEqual([2]);
  });
});

describe("firstPassView: labels", () => {
  const rows = [
    row({ hunkIndex: 0, signals: signals({ slop: 0.9 }) }),
    row({ hunkIndex: 1, signals: signals() }),
    row({ hunkIndex: 2, skipReason: "unscanned" }),
    row({ hunkIndex: 3, skipReason: "generated" }),
  ];

  it("says what a partial scan covered and why it stopped", () => {
    const view = firstPassView(rows, "partial", [], true, null);
    expect(view.running).toBe(false);
    expect(view.result).toBe("1 lead in 2 of 3 hunks");
    expect(view.note).toBe("TypeSafe stopped answering, so 1 hunk was never judged.");
    expect(view.hasLeads).toBe(true);
  });

  it("counts progress while running, and has nothing to fold when nothing is flagged", () => {
    const view = firstPassView(
      [row(), row({ hunkIndex: 1, signals: signals() })],
      "running",
      [],
      false,
      null,
    );
    expect(view.running).toBe(true);
    expect(view.scanning).toBe("Scanning 1 of 2");
    expect(view.result).toBe("No leads in 1 hunk");
    expect(view.note).toBeNull();
    expect(view.hasLeads).toBe(false);
  });
});
