// ── agent-stream ────────────────────────────────────────────────────────────
//
// Shared streaming-response handling for the four provider drivers — chat and
// walkthrough, Claude and opencode. Before this module, each driver decoded
// model output, classified tool calls, and managed the abort + hard-timeout
// envelope on its own; the same code appeared four times with subtle drift.
//
// This file owns:
//
//   1. `NormalizedAgentEvent`         — single union describing what the model
//                                       did (text/reasoning delta, tool call,
//                                       error). Callers switch on the kind and
//                                       map to their own surface (ChatStreamFrame
//                                       or WalkthroughStreamEvent).
//   2. `walkClaudeMessages`           — iterate the Claude SDK async generator,
//                                       emit normalized events. Treats both
//                                       `thinking` and `redacted_thinking`
//                                       blocks as reasoning deltas.
//   3. `subscribeOpencodeStream`      — subscribe to /global/event SSE via
//                                       the SDK, decode `message.part.updated`
//                                       frames into normalized events. Owns
//                                       per-partId delta-dedup state and the
//                                       load-bearing 100ms post-completion
//                                       drain.
//   4. `walkOpencodeParts`            — synchronous walk over the parts array
//                                       returned by `session.prompt`.
//   5. `decodeOpencodePart`           — pure per-Part decoder shared by (3)
//                                       and (4). Returns the event + new
//                                       cumulative-emitted-length so the SSE
//                                       caller can park the state externally.
//   6. `buildActivity`                — normalizeToolName + classifyTool +
//                                       buildExplorationDescription rolled
//                                       into one helper.
//   7. `withAgentTurn`                — abort + hard-timeout + jobStarted/
//                                       jobEnded refcount harness for both
//                                       opencode providers. Surfaces wasTimeout
//                                       and wasCancelled flags so callers can
//                                       compose the right error message.

// Re-export the SDK's Part type for any other file in this package that wants
// to talk about opencode parts without depending on the SDK directly.
export type { Part } from "@opencode-ai/sdk";

// Re-export everything from the split modules so existing import paths work
export * from "./agent-stream/normalized-events";
export * from "./agent-stream/fluid-chunker";
export * from "./agent-stream/claude-walker";
export * from "./agent-stream/opencode-decoders";
export * from "./agent-stream/opencode-sse";
export * from "./agent-stream/agent-turn";
