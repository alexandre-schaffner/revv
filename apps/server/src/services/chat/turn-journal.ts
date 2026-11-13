// A chat turn's frames, journaled as they pass: each frame is written to
// SQLite before it reaches the client (CLAUDE.md invariant 8), so a reload
// shows exactly what was streamed. A write that fails ends the turn with that
// error instead of streaming content no reload would restore.
//
// Sequence rules:
//   - a prose run is one assistant row, opened lazily by its first text chunk
//     and appended to by the rest;
//   - a frame with its own timeline slot (activity, plan) seals the open row,
//     so prose and tool calls interleave by sequence;
//   - frames that patch an existing row (activity result/input) and task-list
//     snapshots (rendered in the queue dock) don't seal;
//   - the turn always ends with a finalized assistant row, carrying the error
//     when the agent failed, so the timeline closes the turn on reload.

import { SpanStatusCode, trace } from "@opentelemetry/api";
import { SPAN_ATTR, spanName } from "@revv/shared/telemetry";
import { Cause, type Context, Effect, Exit } from "effect";
import type { ChatStreamFrame, RawChatStreamFrame } from "../../ai/providers/chat-types";
import type { ChatSessionService } from "./ChatSession";

interface JournalParams {
  readonly source: ReadableStream<RawChatStreamFrame>;
  readonly chatSessions: Context.Service.Shape<typeof ChatSessionService>;
  readonly chatSessionId: string;
  readonly turnId: string;
  readonly prId: string;
  readonly onProgress: () => void;
  /** Stop the agent: the client went away, or the journal failed. */
  readonly stopAgent: () => void;
  /** Runs once the turn is fully journaled, however it ended. */
  readonly release: Effect.Effect<void>;
}

type Read =
  | {
      readonly ok: true;
      readonly result: Awaited<ReturnType<ReadableStreamDefaultReader<RawChatStreamFrame>["read"]>>;
    }
  | { readonly ok: false; readonly error: unknown };

export function journalTurn(params: JournalParams): ReadableStream<ChatStreamFrame> {
  const { chatSessions, chatSessionId, turnId } = params;
  const reader = params.source.getReader();
  let clientGone = false;

  return new ReadableStream<ChatStreamFrame>({
    async start(controller) {
      const span = trace.getTracer("revv-server").startSpan(spanName("chat", "stream"), {
        attributes: { [SPAN_ATTR.prId]: params.prId, [SPAN_ATTR.provider]: "acp" },
      });
      const startedAt = Date.now();
      let firstTokenAt: number | null = null;

      const forward = (frame: ChatStreamFrame) =>
        Effect.sync(() => {
          if (clientGone) return;
          try {
            controller.enqueue(frame);
          } catch {
            clientGone = true;
          }
        });

      let agentError: unknown = null;
      const journal = Effect.gen(function* () {
        let assistantId: string | null = null;
        let textStreamed = false;

        const openAssistant = Effect.gen(function* () {
          if (assistantId === null) {
            assistantId = (yield* chatSessions.beginAssistantMessage({ chatSessionId, turnId })).id;
          }
          return assistantId;
        });
        const seal = Effect.gen(function* () {
          const messageId = assistantId;
          assistantId = null;
          if (messageId) yield* chatSessions.finalizeAssistantMessage({ messageId, error: null });
        });

        while (true) {
          const read: Read = yield* Effect.promise(() =>
            reader.read().then(
              (result) => ({ ok: true as const, result }),
              (error) => ({ ok: false as const, error }),
            ),
          );
          if (!read.ok) {
            agentError = read.error;
            break;
          }
          if (read.result.done) break;
          const frame = read.result.value;
          params.onProgress();
          if (firstTokenAt === null && (frame.kind === "text" || frame.kind === "reasoning")) {
            firstTokenAt = Date.now();
          }
          if (frame.kind === "activity" || frame.kind === "plan-presented") yield* seal;

          switch (frame.kind) {
            case "text":
              if (frame.data.length > 0) {
                textStreamed = true;
                const messageId = yield* openAssistant;
                yield* chatSessions.appendAssistantContent({ messageId, chunk: frame.data });
              }
              yield* forward(frame);
              break;
            case "activity":
              yield* chatSessions.appendActivity({
                chatSessionId,
                turnId,
                activityKind: frame.activityKind,
                toolName: frame.toolName,
                summary: frame.summary,
                payload: frame.payload,
                callId: frame.callId ?? null,
              });
              yield* forward(frame);
              break;
            case "activity-result":
              yield* chatSessions.updateActivityResult({
                chatSessionId,
                turnId,
                callId: frame.callId,
                output: frame.output,
                isError: frame.isError,
              });
              yield* forward(frame);
              break;
            case "activity-input":
              yield* chatSessions.updateActivityInput({
                chatSessionId,
                turnId,
                callId: frame.callId,
                payload: frame.payload,
              });
              yield* forward(frame);
              break;
            case "task-list":
              yield* chatSessions.applyTaskListSnapshot({
                chatSessionId,
                turnId,
                tasks: frame.tasks,
              });
              yield* forward({ kind: "task-list", turnId, tasks: frame.tasks });
              break;
            case "plan-presented": {
              const plan = yield* chatSessions.createPlan({
                chatSessionId,
                turnId,
                markdown: frame.markdown,
              });
              yield* forward({
                kind: "plan-presented",
                planId: plan.id,
                turnId,
                markdown: frame.markdown,
                status: "pending",
              });
              break;
            }
            default:
              yield* forward(frame);
          }
        }

        // A stop the user asked for is not an error to show on reload.
        const error =
          agentError === null || clientGone
            ? null
            : agentError instanceof Error
              ? agentError.message
              : "Stream error";
        if (assistantId === null && (error !== null || !textStreamed)) yield* openAssistant;
        if (assistantId !== null) {
          yield* chatSessions.finalizeAssistantMessage({ messageId: assistantId, error });
        }
      });

      const exit = await Effect.runPromiseExit(journal.pipe(Effect.ensuring(params.release)));
      if (firstTokenAt !== null) span.setAttribute(SPAN_ATTR.ttftMs, firstTokenAt - startedAt);
      const failure = Exit.isFailure(exit) ? exit.cause : null;
      if (failure !== null) {
        params.stopAgent();
        await reader.cancel().catch(() => {});
      }
      if (failure !== null || agentError !== null) span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
      if (clientGone) return;
      try {
        if (failure !== null) controller.error(Cause.squash(failure));
        else if (agentError !== null) controller.error(agentError);
        else controller.close();
      } catch {}
    },
    cancel() {
      // Frames already on their way are still journaled.
      clientGone = true;
      params.stopAgent();
    },
  });
}
