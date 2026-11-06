import { describe, expect, it } from "bun:test";
import {
  RATING_AXES,
  type WalkthroughBlock,
  type WalkthroughEndReason,
  type WalkthroughIssue,
  type WalkthroughRating,
  type WalkthroughStreamEvent,
} from "@revv/shared";
import {
  applyEvents,
  hasAllContent,
  idleEntry,
  isSettledComplete,
  mergeSnapshot,
  startingEntry,
  type WalkthroughEntry,
  type WalkthroughSnapshot,
  walkthroughUiState,
} from "./walkthrough-reducer";

function block(
  id: string,
  order: number,
  semanticStepIndex = 0,
  content = `block ${id}`,
): WalkthroughBlock {
  return {
    type: "markdown",
    id,
    order,
    content,
    semanticStepIndex,
    stepIndex: order,
  };
}

function issue(id: string, over: Partial<WalkthroughIssue> = {}): WalkthroughIssue {
  return { id, severity: "warning", title: id, description: "", blockIds: [], ...over };
}

function rating(axis: WalkthroughRating["axis"]): WalkthroughRating {
  return {
    axis,
    verdict: "pass",
    confidence: "high",
    rationale: "fine",
    details: "",
    citations: [],
    blockIds: [],
  };
}

const ALL_RATINGS = RATING_AXES.map(rating);

function started(walkthroughId: string, over: object = {}): WalkthroughStreamEvent {
  return {
    type: "lifecycle:started",
    data: { walkthroughId, prHeadSha: "abc", trigger: "user", ...over },
  };
}

function full(entry: WalkthroughEntry): WalkthroughEntry {
  return { ...entry, summary: "s", blocks: [block("b1", 0)], ratings: ALL_RATINGS };
}

function snapshot(over: Partial<WalkthroughSnapshot> = {}): WalkthroughSnapshot {
  return {
    status: "complete",
    walkthrough: {
      id: "w1",
      summary: "snap summary",
      riskLevel: "medium",
      blocks: [block("b1", 0)],
      issues: [],
      ratings: [],
      tokenUsage: {},
    },
    ...over,
  };
}

describe("applyEvents", () => {
  it("never mutates the entry it is given", () => {
    const entry = idleEntry("reviewer");
    const frozen = Object.freeze({ ...entry, blocks: Object.freeze([]) as never });
    const next = applyEvents(frozen, [{ type: "block", data: block("b1", 0) }]);
    expect(next.blocks.map((b) => b.id)).toEqual(["b1"]);
    expect(frozen.blocks).toHaveLength(0);
  });

  it("upserts blocks by id and keeps them in order", () => {
    let entry = idleEntry("reviewer");
    entry = applyEvents(entry, [
      { type: "block", data: block("b2", 2) },
      { type: "block", data: block("b1", 1) },
    ]);
    entry = applyEvents(entry, [{ type: "block", data: block("b2", 2, 0, "new") }]);
    expect(entry.blocks.map((b) => b.id)).toEqual(["b1", "b2"]);
    expect(entry.blocks[1]?.type === "markdown" && entry.blocks[1].content).toBe("new");
  });

  it("extends a run of thought until a tool call breaks it", () => {
    const entry = applyEvents(idleEntry("reviewer"), [
      { type: "thought", data: { text: "a" } },
      { type: "thought", data: { text: "b" } },
      {
        type: "exploration",
        data: { activityKind: "read", toolName: "Read", summary: "x" } as never,
      },
      { type: "thought", data: { text: "c" } },
    ]);
    expect(entry.timeline.map((t) => (t.kind === "thought" ? t.text : t.kind))).toEqual([
      "ab",
      "exploration",
      "c",
    ]);
  });

  it("closes Phase D on `lifecycle:complete` only with all content", () => {
    const event: WalkthroughStreamEvent = {
      type: "lifecycle:complete",
      data: {
        walkthroughId: "w1",
        tokenUsage: {
          inputTokens: 3,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          contextTokens: 0,
        },
      },
    };
    const partial = applyEvents(startingEntry("reviewer", ""), [event]);
    expect(partial.doneReceived).toBe(true);
    expect(partial.isStreaming).toBe(false);
    expect(partial.lastCompletedPhase).toBe("none");
    expect(partial.tokenUsage.inputTokens).toBe(3);
    expect(applyEvents(full(startingEntry("reviewer", "")), [event]).lastCompletedPhase).toBe("D");
  });

  describe("`lifecycle:error`", () => {
    const fail = (reason: WalkthroughEndReason, message: string) =>
      applyEvents(startingEntry("reviewer", ""), [
        { type: "lifecycle:error", data: { reason, message } },
      ]);

    it("a user stop is not an error", () => {
      const entry = fail("cancelled", "Walkthrough cancelled");
      expect(entry.streamError).toBeNull();
      expect(entry.streamEndReason).toBeNull();
      expect(entry.isStreaming).toBe(false);
    });

    it("anything else is the message, with why it ended", () => {
      const entry = fail("agent_auth", "Sign in again");
      expect(entry.streamError).toBe("Sign in again");
      expect(entry.streamEndReason).toBe("agent_auth");
    });
  });

  it("drops the previous review when another walkthrough starts", () => {
    const shown = {
      ...full(idleEntry("reviewer")),
      walkthroughId: "old",
      leads: [],
      issues: [issue("i1")],
    };
    const entry = applyEvents(shown, [started("new", { riskLevel: "high", mode: "author" })]);
    expect(entry.walkthroughId).toBe("new");
    expect(entry.summary).toBeNull();
    expect(entry.blocks).toEqual([]);
    expect(entry.issues).toEqual([]);
    expect(entry.leads).toBeNull();
    expect(entry.riskLevel).toBe("high");
    expect(entry.mode).toBe("author");
    expect(entry.isStreaming).toBe(true);
  });

  it("keeps the seed's content when its own run announces itself", () => {
    const seed = { ...startingEntry("reviewer", ""), summary: "early" };
    const entry = applyEvents(seed, [started("w1")]);
    expect(entry.summary).toBe("early");
    expect(entry.walkthroughId).toBe("w1");
  });

  it("removes a chapter with its blocks", () => {
    const entry = applyEvents(
      {
        ...idleEntry("reviewer"),
        semanticSteps: [
          { semanticStepIndex: 0, title: "a", summary: null },
          { semanticStepIndex: 1, title: "b", summary: null },
        ],
        blocks: [block("b0", 0, 0), block("b1", 1, 1)],
      },
      [{ type: "semantic-step:deleted", data: { semanticStepIndex: 1 } }],
    );
    expect(entry.semanticSteps.map((s) => s.title)).toEqual(["a"]);
    expect(entry.blocks.map((b) => b.id)).toEqual(["b0"]);
  });
});

describe("mergeSnapshot", () => {
  it("lets content the SSE delivered during the fetch win over the snapshot", () => {
    const live = {
      ...idleEntry("reviewer"),
      summary: "live summary",
      blocks: [block("b1", 0, 0, "live"), block("b2", 1)],
    };
    const entry = mergeSnapshot(live, snapshot());
    expect(entry.summary).toBe("live summary");
    expect(entry.blocks.map((b) => (b.type === "markdown" ? b.content : ""))).toEqual([
      "live",
      "block b2",
    ]);
    expect(live.blocks).toHaveLength(2);
    expect(entry).not.toBe(live);
  });

  it("never moves the pipeline pointer backwards", () => {
    const live = { ...idleEntry("reviewer"), lastCompletedPhase: "C" as const };
    const generating = snapshot({ status: "generating" });
    expect(
      mergeSnapshot(live, {
        ...generating,
        walkthrough: { ...generating.walkthrough, lastCompletedPhase: "A" },
      }).lastCompletedPhase,
    ).toBe("C");
  });

  it("only trusts the risk tier once the overview or the risk pass landed", () => {
    const generating = snapshot({
      status: "generating",
      walkthrough: { ...snapshot().walkthrough, summary: "", riskLevel: "low" },
    });
    expect(mergeSnapshot(undefined, generating).riskLevel).toBeNull();
    expect(
      mergeSnapshot(undefined, {
        ...generating,
        walkthrough: { ...generating.walkthrough, riskConfidence: 0.8 },
      }).riskLevel,
    ).toBe("low");
  });

  it("keeps live lead verdicts only for the same walkthrough", () => {
    const lead = { id: "L1" } as never;
    const liveVerdict = { id: "L1", verdict: "confirmed" } as never;
    const withLeads = snapshot({ walkthrough: { ...snapshot().walkthrough, leads: [lead] } });
    const same = { ...idleEntry("reviewer"), walkthroughId: "w1", leads: [liveVerdict] };
    expect(mergeSnapshot(same, withLeads).leads).toEqual([liveVerdict]);
    const other = { ...same, walkthroughId: "w0" };
    expect(mergeSnapshot(other, withLeads).leads).toEqual([lead]);
    expect(mergeSnapshot(other, snapshot()).leads).toBeNull();
  });

  it("shows a generating row's run as streaming and never as outdated", () => {
    const entry = mergeSnapshot(undefined, snapshot({ status: "generating", stale: true }), 42);
    expect(entry.isStreaming).toBe(true);
    expect(entry.superseded).toBe(false);
    expect(entry.streamStartedAt).toBe(42);
    expect(entry.doneReceived).toBe(false);
  });

  it("an errored current row carries its message; a historical one doesn't", () => {
    const errored = snapshot({
      status: "error",
      walkthrough: {
        ...snapshot().walkthrough,
        errorMessage: "usage limit",
        endReason: "agent_auth",
      },
    });
    expect(mergeSnapshot(undefined, errored).streamError).toBe("usage limit");
    expect(mergeSnapshot(undefined, errored).streamEndReason).toBe("agent_auth");
    expect(mergeSnapshot(undefined, { ...errored, historical: true }).streamError).toBeNull();
  });

  it("a row the user stopped reads as resumable after a reload, as it does live", () => {
    const stopped = snapshot({
      status: "error",
      walkthrough: {
        ...snapshot().walkthrough,
        errorMessage: "Walkthrough cancelled",
        endReason: "cancelled",
      },
    });
    const entry = mergeSnapshot(undefined, stopped);
    expect(entry.streamError).toBeNull();
    expect(walkthroughUiState(entry).kind).toBe("resumable");
  });
});

describe("completion predicates", () => {
  it("hasAllContent needs a summary, a block and every axis", () => {
    const entry = full(idleEntry("reviewer"));
    expect(hasAllContent(entry)).toBe(true);
    expect(hasAllContent({ ...entry, ratings: ALL_RATINGS.slice(1) })).toBe(false);
  });

  it("isSettledComplete leaves a finished run missing ratings open to a re-read", () => {
    const done = { ...full(idleEntry("reviewer")), doneReceived: true };
    expect(isSettledComplete(done)).toBe(true);
    expect(isSettledComplete({ ...done, ratings: [] })).toBe(false);
    expect(isSettledComplete({ ...done, streamError: "x" })).toBe(false);
  });
});

describe("walkthroughUiState", () => {
  it("orders streaming, stale, error, complete, resumable, idle", () => {
    const idle = idleEntry("reviewer");
    expect(walkthroughUiState(undefined).kind).toBe("absent");
    expect(walkthroughUiState(idle).kind).toBe("idle");
    expect(walkthroughUiState({ ...idle, isStreaming: true, superseded: true }).kind).toBe(
      "streaming",
    );
    expect(walkthroughUiState({ ...idle, superseded: true, streamError: "x" }).kind).toBe(
      "complete-stale",
    );
    expect(walkthroughUiState({ ...idle, streamError: "x" }).kind).toBe("error-empty");
    expect(walkthroughUiState({ ...idle, streamError: "x", summary: "s" }).kind).toBe(
      "error-partial",
    );
    expect(walkthroughUiState({ ...idle, doneReceived: true, lastCompletedPhase: "D" }).kind).toBe(
      "complete",
    );
    expect(walkthroughUiState({ ...idle, summary: "s" }).kind).toBe("resumable");
  });
});
