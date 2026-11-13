// One agent conflict-resolve run, as both of Revv's flows run it (the chat
// push's "resolve and push", the Conversation tab's base sync): opening
// frames, the agent's progress, then the flow's own verify-and-push, streamed
// to the client. The run outlives the request that started it, and the
// client's stream: only a Stop ends it early. The stream ends once its
// cleanup has run.

import type { AgentProgressFrame, ResolveFrame, ResolveResult } from "@revv/shared";
import { type Cause, Deferred, Effect, Queue } from "effect";
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

/** A stream of `frames`, ending once the queue has ended and been drained. */
const queueToStream = <F>(frames: Queue.Queue<F, Cause.Done>): ReadableStream<F> =>
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

export interface ConflictResolveRun<Pushed> {
  /** Sent before the agent starts. */
  readonly opening: readonly ResolveFrame<Pushed>[];
  /** The agent's run is started with its signal; a Stop aborts it. */
  readonly abort: AbortController;
  /** The agent working the conflicts, or null when there are none. */
  readonly agent: Effect.Effect<ReadableStream<RawChatStreamFrame>, AiError> | null;
  /** Verify the agent's work and push it: the frame that ends a run that got this far. */
  readonly finish: (
    offer: (frame: ResolveFrame<Pushed>) => Effect.Effect<void>,
  ) => Effect.Effect<ResolveResult<Pushed>, unknown>;
  /** Puts back what a run that failed or was stopped left, before its result goes out. */
  readonly backOut?: Effect.Effect<void>;
  /** Every frame is progress: holders with an idle expiry re-arm it. */
  readonly onProgress?: () => void;
  /** Runs once, however the run ended, before the stream closes. */
  readonly cleanup: Effect.Effect<void>;
}

/**
 * One flow's runs in flight, one per PR (each holds the PR's source-branch
 * push lock), so a Stop can reach one. Stop aborts the agent's turn: its
 * session is cancelled and its shared connection kept, as a chat turn's
 * Stop does. The run then backs out and its cleanup gives back what it held.
 * A run past its agent, verifying or pushing, is no longer stoppable.
 */
export interface ResolveRuns<Pushed> {
  readonly start: (
    prId: string,
    run: ConflictResolveRun<Pushed>,
  ) => Effect.Effect<ReadableStream<ResolveFrame<Pushed>>>;
  /**
   * Stop the run of `prId` and answer once it has ended, its cleanup done;
   * false, at once, when it had none still stoppable.
   */
  readonly stop: (prId: string) => Effect.Effect<boolean>;
}

/** What a flow's `pushed` result reports, given its frame type. */
export type PushedOf<F> = Omit<
  Extract<F, { readonly status: "pushed" }>,
  "kind" | "status" | "newSha"
>;

interface Stoppable {
  readonly abort: AbortController;
  readonly ended: Deferred.Deferred<void>;
}

export function createResolveRuns<Pushed>(): ResolveRuns<Pushed> {
  const stoppable = new Map<string, Stoppable>();
  const settle = (prId: string, entry: Stoppable) =>
    Effect.sync(() => {
      if (stoppable.get(prId) === entry) stoppable.delete(prId);
    });

  return {
    start: (prId, run) =>
      Effect.gen(function* () {
        const frames = yield* Queue.unbounded<ResolveFrame<Pushed>, Cause.Done>();
        const offer = (frame: ResolveFrame<Pushed>) =>
          Effect.sync(() => run.onProgress?.()).pipe(
            Effect.andThen(Queue.offer(frames, frame)),
            Effect.asVoid,
          );
        const backedOut = (result: ResolveResult<Pushed>) =>
          (run.backOut ?? Effect.void).pipe(Effect.as(result));
        const entry: Stoppable = { abort: run.abort, ended: yield* Deferred.make<void>() };
        stoppable.set(prId, entry);
        yield* Effect.forkDetach(
          Effect.gen(function* () {
            for (const frame of run.opening) yield* offer(frame);
            if (run.agent) yield* pumpAgentFrames(yield* run.agent, offer);
            if (run.abort.signal.aborted) {
              return yield* offer(yield* backedOut({ kind: "result", status: "stopped" }));
            }
            yield* settle(prId, entry);
            yield* offer(yield* run.finish(offer));
          }).pipe(
            Effect.catch((err) =>
              Effect.flatMap(
                backedOut({
                  kind: "result",
                  status: "failed",
                  message: err instanceof Error ? err.message : String(err),
                }),
                offer,
              ),
            ),
            Effect.ensuring(
              settle(prId, entry).pipe(
                Effect.andThen(run.cleanup),
                Effect.ensuring(Queue.end(frames)),
                Effect.ensuring(Deferred.succeed(entry.ended, undefined)),
              ),
            ),
          ),
        );
        return queueToStream(frames);
      }),
    stop: (prId) =>
      Effect.suspend(() => {
        const entry = stoppable.get(prId);
        if (entry === undefined) return Effect.succeed(false);
        stoppable.delete(prId);
        entry.abort.abort(new Error("Stopped by the user"));
        return Deferred.await(entry.ended).pipe(Effect.as(true));
      }),
  };
}
