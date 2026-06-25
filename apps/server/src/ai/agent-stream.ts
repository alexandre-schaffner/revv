// ── agent-stream ────────────────────────────────────────────────────────────
//
// Shared streaming-response handling for the ACP provider drivers (chat,
// walkthrough, recap, suggestions). Now that every feature runs over a single
// ACP transport, this owns the transport-agnostic pieces those drivers share:
//
//   1. `NormalizedAgentEvent`      — single union describing what the model did
//                                    (text/reasoning delta, tool call, task
//                                    list, error). Callers switch on the kind
//                                    and map to their own surface
//                                    (ChatStreamFrame / WalkthroughStreamEvent /
//                                    RecapStreamEvent).
//   2. `decodeAcpSessionUpdate`    — map an ACP `session/update` notification to
//                                    zero or more normalized events.
//   3. `buildActivity`             — normalizeToolName + classifyTool +
//                                    buildExplorationDescription rolled into one.
//   4. `withAgentTurn`             — abort + hard-timeout + jobStarted/jobEnded
//                                    refcount harness. Surfaces wasTimeout /
//                                    wasCancelled so callers compose the right
//                                    error message.
//   5. `fluidEmit`                 — typewriter-cadence chunker for chat.
//   6. token-usage algebra         — accumulate / merge context occupancy.

// Re-export everything from the split modules so existing import paths work
export * from "./agent-stream/acp-decoders";
export * from "./agent-stream/agent-turn";
export * from "./agent-stream/fluid-chunker";
export * from "./agent-stream/normalized-events";
export * from "./agent-stream/token-usage";
