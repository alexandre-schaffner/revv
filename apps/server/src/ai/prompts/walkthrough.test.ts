import { describe, expect, it } from "bun:test";
import type { WalkthroughLead, WalkthroughStackSnapshot } from "@revv/shared";
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

describe("buildWalkthroughPrompt stack block", () => {
  const stack: WalkthroughStackSnapshot = {
    number: 7,
    baseRefName: "main",
    position: 2,
    layers: [
      {
        position: 3,
        number: 122,
        title: "Wire the limiter",
        headSha: "c",
        baseRef: "b",
        status: "draft",
      },
      {
        position: 1,
        number: 120,
        title: "Add the store",
        headSha: "a",
        baseRef: "main",
        status: "merged",
      },
      {
        position: 2,
        number: 121,
        title: "Add a rate limiter",
        headSha: "b",
        baseRef: "a",
        status: "not_ready",
      },
    ],
    capturedAt: "2026-10-16T00:00:00Z",
  };

  it("places the layer in its stack, after the description and before the principles", () => {
    const prompt = buildWalkthroughPrompt({
      ...BASE,
      pr: { ...BASE.pr, body: "Limits requests per token." },
      stack,
    });
    const block = prompt.slice(
      prompt.indexOf("### Stack"),
      prompt.indexOf("\n\n", prompt.indexOf("- A split")),
    );
    expect(block).toBe(
      [
        "### Stack",
        "This pull request is layer 2 of 3 in stack #7, onto `main`.",
        "",
        '- Layer 1: #120 "Add the store" — merged',
        '- Layer 2: #121 "Add a rate limiter" — not ready ← this PR',
        '- Layer 3: #122 "Wire the limiter" — draft',
        "",
        "- The diff below is this layer's own changes only: GitHub scopes it to the layer below.",
        "- Before you flag something as missing, call `get_stack_context`. A higher layer may add it, and an absence a higher layer fills is not an issue.",
        "- Code in lower layers is out of scope unless this layer depends on it. When it does, say so in a comment on this layer's code, not in an issue against the lower layer.",
        "- Cite another layer as `#N (layer k)`.",
        "- Place this layer in the stack in one sentence of the overview's Context part.",
        "- A split recommendation, if there is one, concerns this layer alone.",
      ].join("\n"),
    );
    expect(prompt.indexOf("### Description")).toBeLessThan(prompt.indexOf("### Stack"));
    expect(prompt.indexOf("### Stack")).toBeLessThan(prompt.indexOf("### Changed Files"));
  });

  it("asks for the stack context right after the state, and renumbers what follows", () => {
    const prompt = buildWalkthroughPrompt({ ...BASE, stack, splitRecommendation: { pieces: 2 } });
    expect(prompt).toContain("1. Call `get_walkthrough_state`");
    expect(prompt).toContain("2. Call `get_stack_context` once during Phase A.");
    expect(prompt).toContain("3. Call `get_repo_context`");
    expect(prompt).toContain("5. This pull request has been judged to carry 2");
  });

  it("leaves an unstacked PR's prompt as it was", () => {
    const prompt = buildWalkthroughPrompt({ ...BASE, splitRecommendation: { pieces: 2 } });
    expect(prompt).not.toContain("### Stack");
    expect(prompt).not.toContain("get_stack_context");
    expect(prompt).toContain("2. Call `get_repo_context`");
    expect(prompt).toContain("4. This pull request has been judged to carry 2");
  });

  it("frames a stacked incremental run as the layer's own changed files", () => {
    const prompt = buildWalkthroughPrompt({
      ...BASE,
      stack,
      reviewMode: {
        mode: "incremental",
        parentWalkthroughId: "wt-0",
        baseHeadSha: "old",
        headSha: "new",
        diffSource: "stack_layer_delta",
      },
    });
    expect(prompt).toContain("lower-layer churn excluded");
    expect(prompt).toContain("### Changed Files Since the Prior Review");
  });

  it("tells the agent a layer reverted its change to a file", () => {
    const prompt = buildWalkthroughPrompt({
      ...BASE,
      stack,
      files: [{ ...file("src/gone.ts", ""), status: "reverted", additions: 0, deletions: 0 }],
      reviewMode: {
        mode: "incremental",
        parentWalkthroughId: "wt-0",
        baseHeadSha: "old",
        headSha: "new",
        diffSource: "stack_layer_delta",
      },
    });
    expect(prompt).toContain("#### src/gone.ts (reverted, +0 -0)");
    expect(prompt).toContain("[Change reverted — this layer no longer touches this file]");
  });
});
