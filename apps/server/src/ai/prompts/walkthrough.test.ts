import { describe, expect, it } from "bun:test";
import type { WalkthroughLead } from "@revv/shared";
import type { PrFileMeta } from "../../services/GitHub";
import { buildWalkthroughPrompt } from "./walkthrough";

const BASE = {
  pr: {
    title: "Add a rate limiter",
    body: null,
    sourceBranch: "feat/limit",
    targetBranch: "main",
    url: "https://github.com/o/r/pull/1",
  },
  files: [],
};

const lead = (
  id: string,
  filePath: string,
  newStart: number,
  newLines: number,
  smells: WalkthroughLead["smells"],
): WalkthroughLead => ({
  id,
  filePath,
  hunkIndex: 0,
  newStart,
  newLines,
  smells,
  verdict: null,
  issueId: null,
  reason: null,
});

const file = (filename: string, patch: string): PrFileMeta => ({
  filename,
  previousFilename: null,
  status: "modified",
  additions: 3,
  deletions: 1,
  patch,
});

describe("buildWalkthroughPrompt first-pass leads", () => {
  it("lists each lead under its file's header, in line order", () => {
    const prompt = buildWalkthroughPrompt({
      ...BASE,
      files: [file("src/foo.ts", "@@ -40,3 +42,27 @@\n+x"), file("src/bar.ts", "@@ -1 +7 @@\n+y")],
      hunkLeads: [
        lead("L1", "src/foo.ts", 42, 27, [
          { smell: "over_engineered", probability: 0.861 },
          { smell: "slop", probability: 0.71 },
        ]),
        lead("L2", "src/bar.ts", 7, 1, [{ smell: "vulnerability", probability: 0.5 }]),
        lead("L3", "src/foo.ts", 3, 4, [{ smell: "verbose_comment", probability: 0.7 }]),
      ],
    });
    expect(prompt).toContain(
      "#### src/foo.ts (modified, +3 -1)\nFirst-pass leads:\n- `L3` lines 3–6 — long comment (0.70)\n- `L1` lines 42–68 — over-engineered (0.86), slop (0.71)\n```diff",
    );
    expect(prompt).toContain(
      "#### src/bar.ts (modified, +3 -1)\nFirst-pass leads:\n- `L2` line 7 — vulnerability (0.50)\n```diff",
    );
    // The rules come before the files they annotate, and before the first actions.
    expect(prompt.indexOf("### First-pass leads")).toBeLessThan(prompt.indexOf("#### src/foo.ts"));
    expect(prompt.indexOf("### First-pass leads")).toBeLessThan(prompt.indexOf("## First actions"));
    expect(prompt).toContain("It flagged 3 hunks");
    expect(prompt).toContain("never mention the first pass");
    expect(prompt).not.toContain("#### Other files");
  });

  it("waives the not-cosmetic clause and budgets confirmed info leads outside the tier", () => {
    const prompt = buildWalkthroughPrompt({
      ...BASE,
      hunkLeads: [lead("L1", "src/foo.ts", 3, 4, [{ smell: "verbose_comment", probability: 0.7 }])],
    });
    expect(prompt).toContain(`clause 1's "not cosmetic" does not apply`);
    expect(prompt).toContain("Up to 3 confirmed leads raised as `info` sit outside");
    expect(prompt).not.toContain("worth an `info` issue at most");
    expect(prompt).toContain("Give every lead a verdict with `resolve_lead`");
  });

  it("keeps a lead whose file has no header, and one whose patch was omitted", () => {
    const prompt = buildWalkthroughPrompt(
      {
        ...BASE,
        files: [file("src/big.ts", "x".repeat(400))],
        hunkLeads: [
          lead("L1", "src/big.ts", 10, 2, [{ smell: "silent_failure", probability: 0.8 }]),
          lead("L2", "src/gone.ts", 1, 1, [{ smell: "unclean", probability: 0.75 }]),
        ],
      },
      10,
    );
    expect(prompt).toContain(
      "#### src/big.ts (modified, +3 -1)\nFirst-pass leads:\n- `L1` lines 10–11 — silent failure (0.80)\n[PATCH OMITTED",
    );
    expect(prompt).toContain(
      "#### Other files\nFirst-pass leads:\n- `L2` `src/gone.ts` line 1 — unclean (0.75)",
    );
  });

  it("leaves the section out when there are no leads", () => {
    expect(buildWalkthroughPrompt(BASE)).not.toContain("First-pass leads");
    expect(buildWalkthroughPrompt({ ...BASE, hunkLeads: [] })).not.toContain("First-pass leads");
  });
});
