import { describe, expect, it } from "bun:test";
import type { WalkthroughStreamEvent } from "@revv/shared";
import { ZERO_TOKEN_USAGE } from "../agent-stream";
import { guardWalkthroughStream } from "./stream-guard";

async function* delayedEvents(
  events: readonly WalkthroughStreamEvent[],
  delayMs: number,
): AsyncGenerator<WalkthroughStreamEvent> {
  for (const event of events) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    yield event;
  }
}

async function collectUntilTerminal(
  stream: AsyncGenerator<WalkthroughStreamEvent>,
): Promise<WalkthroughStreamEvent[]> {
  const events: WalkthroughStreamEvent[] = [];
  for await (const event of stream) {
    events.push(event);
    if (event.type === "error" || event.type === "done") break;
  }
  return events;
}

const exploringPhase: WalkthroughStreamEvent = {
  type: "phase",
  data: { phase: "exploring", message: "Reading files and understanding changes..." },
};

const markdownBlock: WalkthroughStreamEvent = {
  type: "block",
  data: {
    type: "markdown",
    id: "b1",
    order: 0,
    content: "Chapter body.",
    phase: "diff_analysis",
    semanticStepIndex: 0,
    stepIndex: 0,
  },
};

describe("guardWalkthroughStream", () => {
  it("does not abort a long exploration phase that only emits heartbeats", async () => {
    // Regression guard: there is no exploration-stall gate. As long as events
    // keep arriving inside the inactivity window, a model that reads files for
    // a long time before producing content runs to completion.
    const stream = guardWalkthroughStream(
      delayedEvents(
        [
          exploringPhase,
          { type: "usage", data: { tokenUsage: ZERO_TOKEN_USAGE } },
          { type: "thought", data: { text: "Still inspecting the diff." } },
          exploringPhase,
          { type: "thought", data: { text: "Reading another file." } },
          exploringPhase,
          {
            type: "summary",
            data: { summary: "Adds indexes for range queries.", riskLevel: "low" },
          },
          {
            type: "done",
            data: { walkthroughId: "walkthrough-1", tokenUsage: ZERO_TOKEN_USAGE },
          },
        ],
        15,
      ),
      {
        firstEventTimeoutMs: 200,
        inactivityTimeoutMs: 200,
        label: "stream-guard-test",
        synthesizePhases: false,
      },
    );

    const events = await collectUntilTerminal(stream);

    expect(events.at(-1)).toMatchObject({
      type: "done",
      data: { walkthroughId: "walkthrough-1" },
    });
  });

  it("aborts with FirstEventTimeout when the provider never starts", async () => {
    const stream = guardWalkthroughStream(delayedEvents([exploringPhase], 200), {
      firstEventTimeoutMs: 40,
      inactivityTimeoutMs: 200,
      label: "stream-guard-test",
      synthesizePhases: false,
    });

    const events = await collectUntilTerminal(stream);

    expect(events.at(-1)).toMatchObject({
      type: "error",
      data: { code: "FirstEventTimeout" },
    });
  });

  it("aborts with InactivityTimeout when events stop mid-stream", async () => {
    async function* stallAfterFirst(): AsyncGenerator<WalkthroughStreamEvent> {
      yield exploringPhase;
      await new Promise((resolve) => setTimeout(resolve, 200));
      yield {
        type: "done",
        data: { walkthroughId: "walkthrough-1", tokenUsage: ZERO_TOKEN_USAGE },
      };
    }

    const stream = guardWalkthroughStream(stallAfterFirst(), {
      firstEventTimeoutMs: 200,
      inactivityTimeoutMs: 50,
      label: "stream-guard-test",
      synthesizePhases: false,
    });

    const events = await collectUntilTerminal(stream);

    expect(events.at(-1)).toMatchObject({
      type: "error",
      data: { code: "InactivityTimeout" },
    });
  });

  it("passes through a terminal done event", async () => {
    const stream = guardWalkthroughStream(
      delayedEvents(
        [
          { type: "summary", data: { summary: "Adds indexes.", riskLevel: "low" } },
          markdownBlock,
          { type: "done", data: { walkthroughId: "walkthrough-1", tokenUsage: ZERO_TOKEN_USAGE } },
        ],
        15,
      ),
      {
        firstEventTimeoutMs: 200,
        inactivityTimeoutMs: 200,
        label: "stream-guard-test",
        synthesizePhases: false,
      },
    );

    const events = await collectUntilTerminal(stream);

    expect(events.at(-1)).toMatchObject({
      type: "done",
      data: { walkthroughId: "walkthrough-1" },
    });
  });

  it("synthesizes a done event when the generator ends after content", async () => {
    const stream = guardWalkthroughStream(
      delayedEvents(
        [{ type: "summary", data: { summary: "Adds indexes.", riskLevel: "low" } }, markdownBlock],
        15,
      ),
      {
        firstEventTimeoutMs: 200,
        inactivityTimeoutMs: 200,
        label: "stream-guard-test",
        synthesizePhases: false,
      },
    );

    const events = await collectUntilTerminal(stream);

    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

  it("synthesizes an error when the generator ends without content", async () => {
    const stream = guardWalkthroughStream(delayedEvents([exploringPhase], 15), {
      firstEventTimeoutMs: 200,
      inactivityTimeoutMs: 200,
      label: "stream-guard-test",
      synthesizePhases: false,
    });

    const events = await collectUntilTerminal(stream);

    expect(events.at(-1)).toMatchObject({
      type: "error",
      data: { code: "IncompleteWalkthrough" },
    });
  });
});
