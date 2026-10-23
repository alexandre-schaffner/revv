// Plumbing shared by the one-shot conflict-resolve runs (the chat push's
// "resolve and push" and the Conversation tab's base sync): forward an agent's
// raw stream as progress frames, and expose a frame queue as the stream an SSE
// route reads.

import type { AgentProgressFrame } from "@revv/shared";
import { Effect, Queue } from "effect";
import type { RawChatStreamFrame } from "../ai/providers/chat-types";

/**
 * Drain `agentStream`, forwarding its text and tool activity through `offer`.
 * Everything else the driver emits (reasoning, plans, questions) means nothing
 * to a one-shot run. A read error ends the pump like end-of-stream: the
 * caller's own verification of the worktree decides whether the run worked.
 */
export const pumpAgentFrames = (
  agentStream: ReadableStream<RawChatStreamFrame>,
  offer: (frame: AgentProgressFrame) => Effect.Effect<unknown>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const reader = agentStream.getReader();
    const readNext = Effect.tryPromise(() => reader.read()).pipe(
      Effect.orElseSucceed(
        (): ReadableStreamReadResult<RawChatStreamFrame> => ({
          done: true,
          value: undefined,
        }),
      ),
    );
    let chunk = yield* readNext;
    while (!chunk.done) {
      const value = chunk.value;
      if (value.kind === "text") {
        yield* offer({ kind: "agent-text", data: value.data });
      } else if (value.kind === "activity") {
        yield* offer({
          kind: "agent-activity",
          activityKind: value.activityKind,
          toolName: value.toolName ?? null,
          summary: value.summary,
          ...(value.payload !== undefined ? { payload: value.payload } : {}),
        });
      }
      chunk = yield* readNext;
    }
  });

/** The queue's frames as a stream that closes once the queue is shut down. */
export const queueToStream = <F>(queue: Queue.Queue<F>): ReadableStream<F> =>
  new ReadableStream<F>({
    async start(controller) {
      try {
        while (true) {
          controller.enqueue(await Effect.runPromise(Queue.take(queue)));
        }
      } catch {
        controller.close();
      }
    },
  });
