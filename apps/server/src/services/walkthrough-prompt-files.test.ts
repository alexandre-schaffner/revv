import { describe, expect, it } from "bun:test";
import type { WalkthroughStackSnapshot } from "@revv/shared";
import { Effect } from "effect";
import { fingerprintFiles } from "./stacks/fingerprint";
import {
  type PromptFile,
  REVERTED_FILE_STATUS,
  resolveIncrementalPromptFiles,
  stackLayerDeltaFiles,
} from "./walkthrough-prompt-files";

const file = (filename: string, patch: string | null, status = "modified"): PromptFile => ({
  filename,
  previousFilename: null,
  status,
  additions: 1,
  deletions: 0,
  patch,
});

const reviewed = [
  file("src/a.ts", "@@ -1 +1 @@\n+a"),
  file("src/b.ts", "@@ -1 +1 @@\n+b"),
  file("src/gone.ts", "@@ -1 +1 @@\n+g"),
];

describe("stackLayerDeltaFiles", () => {
  it("keeps only the layer's files whose own changes moved since the parent review", () => {
    const now = [
      file("src/a.ts", "@@ -1 +1 @@\n+a"),
      file("src/b.ts", "@@ -1 +1 @@\n+b2"),
      file("src/new.ts", "@@ -0,0 +1 @@\n+n", "added"),
    ];
    expect(stackLayerDeltaFiles(now, fingerprintFiles(reviewed)).map((f) => f.filename)).toEqual([
      "src/b.ts",
      "src/new.ts",
      "src/gone.ts",
    ]);
  });

  it("names a file the layer stopped changing as reverted, with no patch", () => {
    const now = reviewed.slice(0, 2);
    expect(stackLayerDeltaFiles(now, fingerprintFiles(reviewed))).toEqual([
      {
        filename: "src/gone.ts",
        previousFilename: null,
        status: REVERTED_FILE_STATUS,
        additions: 0,
        deletions: 0,
        patch: null,
      },
    ]);
  });

  it("treats a shifted hunk header as a change: the old anchors no longer hold", () => {
    const now = [file("src/a.ts", "@@ -4 +4 @@\n+a"), ...reviewed.slice(1)];
    expect(stackLayerDeltaFiles(now, fingerprintFiles(reviewed)).map((f) => f.filename)).toEqual([
      "src/a.ts",
    ]);
  });

  it("always hands over a file GitHub sent without a patch", () => {
    const withBlob = [...reviewed, file("logo.png", null, "added")];
    expect(
      stackLayerDeltaFiles(withBlob, fingerprintFiles(withBlob)).map((f) => f.filename),
    ).toEqual(["logo.png"]);
  });
});

describe("resolveIncrementalPromptFiles on a stacked layer", () => {
  const stack: WalkthroughStackSnapshot = {
    number: 7,
    baseRefName: "main",
    position: 2,
    layers: [],
    capturedAt: "2026-10-16T00:00:00Z",
  };
  const ctx = {
    pr: { id: "pr-1" },
    token: "t",
    prHeadSha: "new",
    repoFullName: "o/r",
    githubHost: "github.com",
    files: [file("src/a.ts", "@@ -1 +1 @@\n+a"), file("src/b.ts", "@@ -1 +1 @@\n+b2")],
    generationMode: "incremental" as const,
    baseHeadSha: "old",
  };

  it("uses the layer delta without touching git when the parent recorded a fingerprint", async () => {
    const result = await Effect.runPromise(
      resolveIncrementalPromptFiles(
        { ...ctx, stack, parentFingerprint: fingerprintFiles(reviewed) },
        "/nonexistent",
      ),
    );
    expect(result.diffSource).toBe("stack_layer_delta");
    expect(result.files.map((f) => f.filename)).toEqual(["src/b.ts", "src/gone.ts"]);
  });

  it("keeps the full diff for a full run", async () => {
    const result = await Effect.runPromise(
      resolveIncrementalPromptFiles(
        {
          ...ctx,
          generationMode: "full",
          stack,
          parentFingerprint: fingerprintFiles(reviewed),
        },
        "/nonexistent",
      ),
    );
    expect(result.diffSource).toBe("full_pr");
    expect(result.files).toHaveLength(2);
  });
});
