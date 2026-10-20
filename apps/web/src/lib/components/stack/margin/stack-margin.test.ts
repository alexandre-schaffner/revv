import { describe, expect, it } from "bun:test";
import type { PrStackDetail, StackBrief, StackLayer } from "@revv/shared";
import {
  conventionalScope,
  layerHint,
  marginNotes,
  placePhrase,
  plainTitle,
  richText,
  stackChapters,
  stackPlace,
} from "./stack-margin";

function layer(position: number, number: number, title: string, extra: Partial<StackLayer> = {}) {
  return {
    position,
    number,
    title,
    url: "",
    headRef: `b${number}`,
    status: "draft",
    headSha: `s${number}`,
    baseRef: "main",
    mergeStateStatus: null,
    reviewDecision: null,
    viewerReview: null,
    checks: null,
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    authorLogin: null,
    mergedAt: null,
    autoMergeEnabled: false,
    isInMergeQueue: false,
    prId: `pr-${number}`,
    review: { kind: "none" },
    restack: { kind: "unknown" },
    ...extra,
  } as StackLayer;
}

const BASE = layer(1, 10, "feat(db): add table", { status: "merged" });
const HERE = layer(2, 11, "feat(api): write entries");
const ABOVE = layer(3, 12, "feat(api): list entries");
const TOP = layer(4, 13, "feat(app): audit page");
const LAYERS = [BASE, HERE, ABOVE, TOP];

function brief(overrides: Partial<StackBrief> = {}): StackBrief {
  return {
    id: "b1",
    status: "complete",
    stale: false,
    arc: "",
    reviewOrder: [],
    completedAt: null,
    layers: [
      { position: 1, prNumber: 10, role: "", reviewFocus: "", chapter: "Storage", buildsOn: [] },
      {
        position: 2,
        prNumber: 11,
        role: "Writes entries on top of #10's `audit` table.",
        reviewFocus: "",
        chapter: "API",
        buildsOn: [{ number: 10, uses: "the `audit` table" }],
      },
      {
        position: 3,
        prNumber: 12,
        role: "",
        reviewFocus: "",
        chapter: "API",
        buildsOn: [{ number: 11, uses: "the entry writer" }],
      },
      {
        position: 4,
        prNumber: 13,
        role: "",
        reviewFocus: "",
        chapter: "UI",
        buildsOn: [
          { number: 11, uses: "the entry shape" },
          { number: 12, uses: "the list endpoint" },
        ],
      },
    ],
    ...overrides,
  };
}

function stack(overrides: Partial<PrStackDetail> = {}): PrStackDetail {
  return {
    repositoryId: "r",
    number: 1,
    baseRefName: "main",
    layers: LAYERS,
    viewerPosition: 2,
    autoMergeAllowed: false,
    allowedMethods: [],
    brief: brief(),
    overlaps: [],
    viewerCanPush: false,
    fetchedAt: "",
    stale: false,
    ...overrides,
  };
}

describe("wording", () => {
  it("names the place in words, the top as last", () => {
    expect(placePhrase(2, 18)).toBe("Second of 18 layers");
    expect(placePhrase(3, 3)).toBe("Last of 3 layers");
    expect(placePhrase(23, 30)).toBe("Layer 23 of 30");
  });

  it("strips and reads conventional-commit prefixes", () => {
    expect(plainTitle("feat(api)!: enforce roles")).toBe("Enforce roles");
    expect(conventionalScope("feat(api)!: enforce roles")).toBe("api");
    expect(conventionalScope("chore: tidy")).toBeNull();
  });

  it("chips stack members and code, leaves other numbers as text", () => {
    const parts = richText("Uses #10 and #99 via `table`.", LAYERS);
    expect(parts.map((p) => p.kind)).toEqual(["text", "layer", "text", "code", "text"]);
    expect(parts[2]).toEqual({ kind: "text", text: " and #99 via " });
  });
});

describe("stackChapters", () => {
  it("uses the brief's chapters when every layer has one", () => {
    expect(stackChapters(LAYERS, brief()).map((c) => [c.name, c.layers.length])).toEqual([
      ["Storage", 1],
      ["API", 2],
      ["UI", 1],
    ]);
  });

  it("falls back to runs of the same scope", () => {
    const partial = brief();
    const layers = partial.layers.slice(1);
    expect(stackChapters(LAYERS, { ...partial, layers }).map((c) => c.name)).toEqual([
      "db",
      "api",
      "app",
    ]);
    expect(stackChapters(LAYERS, null).map((c) => c.name)).toEqual(["db", "api", "app"]);
  });
});

describe("stackPlace", () => {
  it("reads role, links both ways, and the next layer", () => {
    const place = stackPlace(stack(), "pr-11", 11, " Audit log ");
    expect(place?.headline).toBe("Audit log");
    expect(place?.role).toBe("Writes entries on top of #10's `audit` table.");
    expect(place?.buildsOn.map((l) => [l.layer.number, l.uses])).toEqual([
      [10, "the `audit` table"],
    ]);
    expect(place?.usedBy.map((l) => [l.layer.number, l.uses])).toEqual([
      [12, "the entry writer"],
      [13, "the entry shape"],
    ]);
    expect(place?.next?.number).toBe(12);
    expect(place?.briefState).toBe("current");
  });

  it("has no roles or links without a readable brief", () => {
    const writing = stackPlace(
      stack({ brief: brief({ status: "generating" }) }),
      "pr-11",
      11,
      null,
    );
    expect(writing?.briefState).toBe("writing");
    expect(writing?.role).toBeNull();
    expect(writing?.usedBy).toEqual([]);
    expect(stackPlace(stack({ brief: null }), "pr-11", 11, null)?.briefState).toBe("none");
    expect(
      stackPlace(stack({ brief: brief({ stale: true }) }), "pr-11", 11, null)?.briefState,
    ).toBe("stale");
  });

  it("finds the layer by number when the stack read has no Revv id for it", () => {
    const layers = LAYERS.map((l) => (l.number === 11 ? { ...l, prId: null } : l));
    expect(stackPlace(stack({ layers }), "pr-x", 11, null)?.here.number).toBe(11);
    expect(stackPlace(stack({ layers: LAYERS.slice(0, 1) }), "pr-10", 10, null)).toBeNull();
  });
});

describe("marginNotes", () => {
  const overlaps = [
    { number: 10, position: 1, files: ["a.ts"] },
    { number: 12, position: 3, files: ["a.ts", "b.ts"] },
    { number: 13, position: 4, files: ["b.ts", "c.ts"] },
  ];

  it("notes each upper overlap once, at its first spot, issues before chapters", () => {
    const place = stackPlace(stack({ overlaps }), "pr-11", 11, null);
    if (!place) throw new Error("no place");
    const notes = marginNotes(
      place,
      [
        { id: "i1", filePath: "a.ts" },
        { id: "i2", filePath: "a.ts" },
        { id: "i3", filePath: "z.ts" },
      ],
      [
        { index: 0, files: ["a.ts"] },
        { index: 1, files: ["b.ts", "c.ts"] },
        { index: 2, files: ["c.ts"] },
      ],
    );
    expect([...notes.issues.keys()]).toEqual(["i1"]);
    expect(notes.issues.get("i1")?.layers.map((l) => l.number)).toEqual([12]);
    expect([...notes.chapters.keys()]).toEqual([1]);
    expect(notes.chapters.get(1)?.layers.map((l) => l.number)).toEqual([12, 13]);
    expect(notes.chapters.get(1)?.files).toEqual(["b.ts", "c.ts"]);
    expect(notes.reliedOn.map((l) => l.layer.number)).toEqual([12, 13]);
  });

  it("says nothing when no upper layer shares a file", () => {
    const place = stackPlace(
      stack({ overlaps: overlaps.slice(0, 1), brief: null }),
      "pr-11",
      11,
      null,
    );
    if (!place) throw new Error("no place");
    const notes = marginNotes(
      place,
      [{ id: "i1", filePath: "a.ts" }],
      [{ index: 0, files: ["a.ts"] }],
    );
    expect(notes.issues.size).toBe(0);
    expect(notes.chapters.size).toBe(0);
    expect(notes.reliedOn).toEqual([]);
  });
});

describe("layerHint", () => {
  it("only says what tells the reader something", () => {
    expect(layerHint(HERE, HERE)).toBe("This layer");
    expect(layerHint(BASE, HERE)).toBe("Landed");
    expect(layerHint(ABOVE, HERE)).toBe("");
    const reviewed = layer(3, 12, "x", {
      review: {
        kind: "complete",
        walkthroughId: "w",
        riskLevel: "medium",
        openIssues: 1,
        criticalIssues: 0,
        takeaway: null,
        reviewedHeadSha: null,
        carried: false,
      },
    });
    expect(layerHint(reviewed, HERE)).toBe("Medium risk · 1 issue");
  });
});
