import { describe, expect, it } from "bun:test";
import { addressesActiveWalkthrough, type EventTargetEntry } from "./walkthrough-event-target";

const A = "walkthrough-a";
const B = "walkthrough-b";

const entry = (over: Partial<EventTargetEntry> = {}): EventTargetEntry => ({
  walkthroughId: null,
  isStreaming: false,
  liveGeneration: false,
  ...over,
});

describe("addressesActiveWalkthrough", () => {
  it("accepts events for the followed walkthrough", () => {
    expect(addressesActiveWalkthrough(entry({ walkthroughId: A }), A, "block")).toBe(true);
    expect(addressesActiveWalkthrough(entry({ walkthroughId: A }), A, "lifecycle:superseded")).toBe(
      true,
    );
  });

  it("rejects events for a different walkthrough", () => {
    expect(addressesActiveWalkthrough(entry({ walkthroughId: A }), B, "block")).toBe(false);
    expect(addressesActiveWalkthrough(entry({ walkthroughId: A }), B, "lifecycle:superseded")).toBe(
      false,
    );
  });

  it("rejects a stale supersede that lands on a just-requested generation", () => {
    // Regenerate seeded a fresh entry (streaming, id not yet known) and the
    // previous row's supersede envelope arrives late.
    const seeded = entry({ walkthroughId: null, isStreaming: true });
    expect(addressesActiveWalkthrough(seeded, A, "lifecycle:superseded")).toBe(false);
    expect(addressesActiveWalkthrough(seeded, A, "lifecycle:error")).toBe(false);
    expect(addressesActiveWalkthrough(seeded, A, "done")).toBe(false);
  });

  it("still takes content while waiting for its own lifecycle:started", () => {
    const seeded = entry({ walkthroughId: null, isStreaming: true });
    expect(addressesActiveWalkthrough(seeded, A, "block")).toBe(true);
    expect(addressesActiveWalkthrough(seeded, A, "exploration")).toBe(true);
  });

  it("takes everything for an idle mount-time seed that has no id yet", () => {
    const seed = entry({ walkthroughId: null, isStreaming: false, liveGeneration: false });
    expect(addressesActiveWalkthrough(seed, A, "lifecycle:complete")).toBe(true);
    expect(addressesActiveWalkthrough(seed, A, "summary")).toBe(true);
  });

  // `liveGeneration` is the second half of the "we asked for this" signal, and
  // was previously untested on its own: only `isStreaming` was exercised, so a
  // regression that dropped the `liveGeneration` term from the guard would have
  // gone unnoticed.
  it("rejects a stale terminal envelope for a live generation that isn't streaming yet", () => {
    const requested = entry({ walkthroughId: null, isStreaming: false, liveGeneration: true });
    expect(addressesActiveWalkthrough(requested, A, "lifecycle:superseded")).toBe(false);
    expect(addressesActiveWalkthrough(requested, A, "done")).toBe(false);
  });

  it("still takes content for a live generation that isn't streaming yet", () => {
    const requested = entry({ walkthroughId: null, isStreaming: false, liveGeneration: true });
    expect(addressesActiveWalkthrough(requested, A, "block")).toBe(true);
    expect(addressesActiveWalkthrough(requested, A, "summary")).toBe(true);
  });
});
