import { describe, expect, test } from "bun:test";
import {
  agreesWithMirror,
  classifyLayerMergeState,
  type GitHubStack,
  type MirroredLayer,
  stackFromMirror,
  stackStatus,
} from "./map";

const POLLED = "2026-10-19T10:00:00.000Z";

function row(number: number, position: number, over: Partial<MirroredLayer> = {}): MirroredLayer {
  return {
    number,
    position,
    title: `#${number}`,
    url: "",
    status: "open",
    isDraft: false,
    sourceBranch: `b${number}`,
    targetBranch: position === 1 ? "main" : `b${number - 1}`,
    headSha: `h${number}`,
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    authorLogin: "alex",
    closedAt: null,
    fetchedAt: POLLED,
    ...over,
  };
}

/** The 18-layer stack before it was rebuilt: #3923 sat on two merged layers. */
function oldStack(fetchedAt: string): GitHubStack {
  const stack = stackFromMirror(
    3966,
    [
      row(3964, 1, { status: "merged" }),
      row(3965, 2, { status: "merged" }),
      row(3923, 3),
      row(3925, 4),
    ],
    fetchedAt,
  );
  if (!stack) throw new Error("fixture");
  return stack;
}

describe("agreesWithMirror", () => {
  // The rebuild re-created the stack with #4112 underneath #3923.
  const rebuilt = [row(4112, 1), row(3923, 2), row(3925, 3)];

  test("an older read that disagrees with the poll on the open layers is refused", () => {
    expect(agreesWithMirror(oldStack("2026-10-19T05:00:00.000Z"), rebuilt)).toBe(false);
  });

  test("an older read with the same open layers at the same places is fine", () => {
    const same = [row(3923, 3), row(3925, 4)];
    expect(agreesWithMirror(oldStack("2026-10-19T05:00:00.000Z"), same)).toBe(true);
  });

  test("a read taken after the poll's last listing wins", () => {
    expect(agreesWithMirror(oldStack("2026-10-19T11:00:00.000Z"), rebuilt)).toBe(true);
  });
});

describe("stackFromMirror", () => {
  test("rebuilds the stack in the poll's order, base from the bottom layer", () => {
    const stack = stackFromMirror(4113, [row(3923, 2), row(4112, 1, { isDraft: true })], POLLED);
    expect(stack?.baseRefName).toBe("main");
    expect(stack?.layers.map((l) => [l.number, l.status])).toEqual([
      [4112, "draft"],
      [3923, "not_ready"],
    ]);
    expect(stack?.allowedMethods).toEqual([]);
  });

  test("a stack of one is just a PR", () => {
    expect(stackFromMirror(4113, [row(4112, 1)], POLLED)).toBeNull();
  });
});

describe("stackStatus", () => {
  test.each([
    ["MERGED", false, "UNKNOWN", "merged"],
    ["CLOSED", false, "CLEAN", "closed"],
    ["OPEN", true, "CLEAN", "draft"],
    ["OPEN", false, "CLEAN", "ready"],
    ["OPEN", false, "UNSTABLE", "ready"],
    ["OPEN", false, "BLOCKED", "not_ready"],
    ["OPEN", false, null, "not_ready"],
  ] as const)("%s draft=%s %s → %s", (state, isDraft, mergeStateStatus, status) => {
    expect(stackStatus({ state, isDraft, mergeStateStatus })).toBe(status);
  });
});

describe("classifyLayerMergeState", () => {
  const of = (mergeStateStatus: string | null, behindBy: number | null = null) =>
    classifyLayerMergeState({ mergeStateStatus, behindBy });

  test("reads GitHub's states, a compare's behind count over a mergeable one", () => {
    expect(of("CLEAN")).toBe("mergeable");
    expect(of("UNSTABLE")).toBe("mergeable");
    expect(of("CLEAN", 2)).toBe("behind");
    expect(of("BEHIND")).toBe("behind");
    expect(of("DIRTY", 2)).toBe("conflicts");
    expect(of("BLOCKED")).toBe("blocked");
    expect(of(null)).toBe("unknown");
    expect(of("UNKNOWN")).toBe("unknown");
    expect(of("DRAFT")).toBe("unmodeled");
  });
});
