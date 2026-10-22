import { describe, expect, test } from "bun:test";
import { classifyLayerMergeState } from "@revv/shared";
import {
  type GitHubStack,
  type MirroredLayer,
  membershipSupersededByPoll,
  stackFromMirror,
  stackStatus,
} from "./map";
import { chooseStackSource } from "./StackService";

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

const rebuilt = [row(4112, 1), row(3923, 2), row(3925, 3)];
const same = [row(3923, 3), row(3925, 4)];

describe("membershipSupersededByPoll", () => {
  test("an older read the poll since saw with different open layers is superseded", () => {
    expect(membershipSupersededByPoll(oldStack("2026-10-19T05:00:00.000Z"), rebuilt)).toBe(true);
  });

  test("an older read with the same open layers at the same places stands", () => {
    expect(membershipSupersededByPoll(oldStack("2026-10-19T05:00:00.000Z"), same)).toBe(false);
  });

  test("a read taken after the poll's last listing stands", () => {
    expect(membershipSupersededByPoll(oldStack("2026-10-19T11:00:00.000Z"), rebuilt)).toBe(false);
  });
});

describe("chooseStackSource", () => {
  const at = (iso: string) => Date.parse(iso);

  test("a young read that stands is served from the cache", () => {
    const cached = oldStack("2026-10-19T11:00:00.000Z");
    const source = chooseStackSource({
      cached,
      mirror: rebuilt,
      stackNumber: 3966,
      now: at("2026-10-19T11:00:10.000Z"),
      revalidateFor: null,
    });
    expect(source).toEqual({ kind: "fresh-cache", stack: cached });
  });

  test("an older read that stands is answered now and re-read for the asking page", () => {
    const cached = oldStack("2026-10-19T05:00:00.000Z");
    const source = chooseStackSource({
      cached,
      mirror: same,
      stackNumber: 3966,
      now: at("2026-10-19T12:00:00.000Z"),
      revalidateFor: "acct",
    });
    expect(source).toEqual({ kind: "cache-then-revalidate", stack: cached, accountId: "acct" });
  });

  test("without a page asking, an older read is only the fallback for an unreachable GitHub", () => {
    const cached = oldStack("2026-10-19T05:00:00.000Z");
    const source = chooseStackSource({
      cached,
      mirror: same,
      stackNumber: 3966,
      now: at("2026-10-19T12:00:00.000Z"),
      revalidateFor: null,
    });
    expect(source).toEqual({ kind: "github", ifUnreachable: cached });
  });

  test("a superseded read is never served: the fallback is the poll's rebuild", () => {
    const source = chooseStackSource({
      cached: oldStack("2026-10-19T05:00:00.000Z"),
      mirror: rebuilt,
      stackNumber: 4113,
      now: at("2026-10-19T12:00:00.000Z"),
      revalidateFor: "acct",
    });
    expect(source.kind).toBe("github");
    if (source.kind !== "github") return;
    expect(source.ifUnreachable?.number).toBe(4113);
    expect(source.ifUnreachable?.layers.map((l) => l.number)).toEqual([4112, 3923, 3925]);
  });

  test("with no cache and no stack in the poll's rows there is nothing to fall back on", () => {
    const source = chooseStackSource({
      cached: null,
      mirror: [row(4112, 1)],
      stackNumber: 4113,
      now: at("2026-10-19T12:00:00.000Z"),
      revalidateFor: "acct",
    });
    expect(source).toEqual({ kind: "github", ifUnreachable: null });
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
