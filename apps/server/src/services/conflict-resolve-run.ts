// One agent conflict-resolve run, as both of Revv's flows run it (the chat
// push's "resolve and push", the Conversation tab's base sync): opening
// frames, the agent's progress, then the flow's own verify-and-push, streamed
// to the client. The run outlives the request that started it; the stream ends
// once its cleanup has run.

import type { AgentProgressFrame } from "@revv/shared";
import { Effect, Queue } from "effect";
import type { RawChatStreamFrame } from "../ai/providers/chat-types";
import type { AiError } from "../domain/errors";

/**
 * Only text and tool activity are forwarded: reasoning, plans and questions
 * mean nothing to a one-shot run. A read error ends the pump like
 * end-of-stream: the flow's own verification of the worktree decides whether
 * the run worked.
 */
const pumpAgentFrames = (
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
        yield* offer({ ...value, kind: "agent-activity" });
      }
      chunk = yield* readNext;
    }
  });

/** A stream of `frames`, ending once the queue is shut down. */
export const queueToStream = <F>(frames: Queue.Queue<F>): ReadableStream<F> =>
  new ReadableStream<F>({
    async start(controller) {
      try {
        while (true) {
          controller.enqueue(await Effect.runPromise(Queue.take(frames)));
        }
      } catch {
        controller.close();
      }
    },
  });

export interface ConflictResolveRun<F, R> {
  /** Sent before the agent starts. */
  readonly opening: readonly F[];
  /** The agent working the conflicts, or null when there are none. */
  readonly agent: Effect.Effect<ReadableStream<RawChatStreamFrame>, AiError> | null;
  /** Verify the agent's work and push it: the frame that ends a run that got this far. */
  readonly finish: (offer: (frame: F) => Effect.Effect<void>) => Effect.Effect<F, unknown, R>;
  /** The frame that ends a run that failed with `message`, once what it left is backed out. */
  readonly failed: (message: string) => Effect.Effect<F>;
  /** Every frame is progress: holders with an idle expiry re-arm it. */
  readonly onProgress?: () => void;
  /** Runs once, however the run ended, before the stream closes. */
  readonly cleanup: Effect.Effect<void>;
}

export const runConflictResolve = <F, R>(
  run: ConflictResolveRun<F | AgentProgressFrame, R>,
): Effect.Effect<ReadableStream<F | AgentProgressFrame>, never, R> =>
  Effect.gen(function* () {
    const frames = yield* Queue.unbounded<F | AgentProgressFrame>();
    const offer = (frame: F | AgentProgressFrame) =>
      Effect.sync(() => run.onProgress?.()).pipe(
        Effect.andThen(Queue.offer(frames, frame)),
        Effect.asVoid,
      );
    yield* Effect.forkDetach(
      Effect.gen(function* () {
        for (const frame of run.opening) yield* offer(frame);
        if (run.agent) yield* pumpAgentFrames(yield* run.agent, offer);
        yield* offer(yield* run.finish(offer));
      }).pipe(
        Effect.catch((err) =>
          Effect.flatMap(run.failed(err instanceof Error ? err.message : String(err)), offer),
        ),
        Effect.ensuring(run.cleanup.pipe(Effect.ensuring(Queue.shutdown(frames)))),
      ),
    );
    return queueToStream(frames);
  });
