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

describe("guardWalkthroughStream", () => {
  it("does not treat phase heartbeats as report progress", async () => {
    const stream = guardWalkthroughStream(
      delayedEvents(
        [
          {
            type: "phase",
            data: { phase: "exploring", message: "Reading files and understanding changes..." },
          },
          { type: "usage", data: { tokenUsage: ZERO_TOKEN_USAGE } },
          { type: "thought", data: { text: "Still inspecting the diff." } },
          {
            type: "phase",
            data: { phase: "exploring", message: "Reading files and understanding changes..." },
          },
        ],
        15,
      ),
      {
        explorationStallMs: 30,
        firstEventTimeoutMs: 100,
        inactivityTimeoutMs: 100,
        label: "stream-guard-test",
        synthesizePhases: false,
      },
    );

    const events = await collectUntilTerminal(stream);

    expect(events.at(-1)).toMatchObject({
      type: "error",
      data: { code: "ExplorationStall" },
    });
  });

  it("resets the report-progress stall timer when content arrives", async () => {
    const stream = guardWalkthroughStream(
      delayedEvents(
        [
          {
            type: "phase",
            data: { phase: "exploring", message: "Reading files and understanding changes..." },
          },
          {
            type: "summary",
            data: { summary: "Adds indexes for range queries.", riskLevel: "low" },
          },
          {
            type: "phase",
            data: { phase: "exploring", message: "Reading files and understanding changes..." },
          },
          {
            type: "done",
            data: { walkthroughId: "walkthrough-1", tokenUsage: ZERO_TOKEN_USAGE },
          },
        ],
        15,
      ),
      {
        explorationStallMs: 40,
        firstEventTimeoutMs: 100,
        inactivityTimeoutMs: 100,
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
});
