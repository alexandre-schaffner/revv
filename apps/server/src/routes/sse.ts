// ── Server-sent events ──────────────────────────────────────────────────────
//
// Every streaming response goes through here: the global `/api/events`
// stream, chat turns, push and base-conflict resolution, recaps, and the
// agent install/login streams. The wire format (`data: <json>` frames, a
// `data: [DONE]` terminator, `event: error` failures) is shared with the web
// client through `@revv/shared`'s stream-frames.

import { SSE_DONE_FRAME, type StreamErrorBody, sseErrorFrame } from "@revv/shared";
import { Cause, type Effect, Exit } from "effect";
import { httpErrorOf, isAppError } from "../domain/errors";
import { debug, logError } from "../logger";
import { AppRuntime, type AppServices } from "../runtime";

const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * Heartbeats keep Bun's idle timeout and WKWebView's TCP-idle drop from
 * killing a quiet stream. The fetch-based client skips `:` comment lines, but
 * the browser's `EventSource` never surfaces comments, so the global stream's
 * liveness watchdog needs a named event instead.
 */
const HEARTBEAT_FRAMES = {
  comment: ": ping\n\n",
  event: "event: heartbeat\ndata: {}\n\n",
} as const;

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
  // Disables buffering in any reverse proxy on the path.
  "X-Accel-Buffering": "no",
} as const;

const encoder = new TextEncoder();

export interface SseChannel<E = unknown> {
  /** Send one `data:` frame. False once the client is gone. */
  readonly send: (event: E) => boolean;
  /** Send the `[DONE]` terminator and close. */
  readonly done: () => void;
  /** Send an `event: error` frame and close. */
  readonly fail: (body: StreamErrorBody) => void;
  /** Close without a terminator. Idempotent. */
  readonly close: () => void;
  readonly isClosed: () => boolean;
  /** Run `fn` once when the stream closes, from either end; at once if it already has. */
  readonly onClose: (fn: () => void) => void;
}

interface SseOptions {
  readonly heartbeat?: keyof typeof HEARTBEAT_FRAMES;
  /** The request's signal, so a client abort closes the stream. */
  readonly signal?: AbortSignal;
}

/** Open an SSE response. The handler returns `response` and writes through `channel`. */
export function openSse<E = unknown>(
  options: SseOptions = {},
): { response: Response; channel: SseChannel<E> } {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  const closeHooks: Array<() => void> = [];

  const runCloseHooks = (): void => {
    for (const fn of closeHooks.splice(0)) {
      try {
        fn();
      } catch (err) {
        logError("sse", "close hook failed:", err instanceof Error ? err.message : String(err));
      }
    }
  };

  const teardown = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    options.signal?.removeEventListener("abort", teardown);
    try {
      controller.close();
    } catch {
      // The client already cancelled the stream.
    }
    runCloseHooks();
  };

  const write = (text: string): boolean => {
    if (closed) return false;
    try {
      controller.enqueue(encoder.encode(text));
      return true;
    } catch (err) {
      logError("sse", "enqueue failed:", err instanceof Error ? err.message : String(err));
      teardown();
      return false;
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      teardown();
    },
  });

  const heartbeatFrame = HEARTBEAT_FRAMES[options.heartbeat ?? "comment"];
  const heartbeat = setInterval(() => write(heartbeatFrame), HEARTBEAT_INTERVAL_MS);
  options.signal?.addEventListener("abort", teardown, { once: true });

  const channel: SseChannel<E> = {
    send: (event) => write(`data: ${JSON.stringify(event)}\n\n`),
    done: () => {
      write(SSE_DONE_FRAME);
      teardown();
    },
    fail: (body) => {
      write(sseErrorFrame(body));
      teardown();
    },
    close: teardown,
    isClosed: () => closed,
    onClose: (fn) => {
      if (closed) fn();
      else closeHooks.push(fn);
    },
  };

  return { response: new Response(stream, { headers: SSE_HEADERS }), channel };
}

/**
 * Stream `frames` as SSE, one `data:` frame each, then `[DONE]`. A stream
 * that errors with a domain error ends with that error's code from the table,
 * anything else with `GENERATION_ERROR`; a client that leaves cancels `frames`.
 */
export function pipeToSse<T>(frames: ReadableStream<T>): Response {
  const { response, channel } = openSse<T>();
  const reader = frames.getReader();
  channel.onClose(() => {
    reader.cancel().catch(() => {});
  });
  void (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!channel.send(value)) {
          debug("sse", "client disconnected mid-stream");
          return;
        }
      }
      channel.done();
    } catch (err) {
      if (isAppError(err)) {
        const { code, message, details } = httpErrorOf(err);
        channel.fail({ ...details, code, message });
        return;
      }
      channel.fail({
        code: "GENERATION_ERROR",
        message: err instanceof Error ? err.message : "Unknown error",
      });
    }
  })();
  return response;
}

/**
 * Run the work that opens a stream. A failure before the stream starts
 * answers with its HTTP status and a `{ code, message }` body.
 */
export async function runStream<E>(
  work: Effect.Effect<Response, E, AppServices>,
): Promise<Response> {
  const exit = await AppRuntime.runPromiseExit(work);
  if (Exit.isSuccess(exit)) return exit.value;
  const { status, code, message, details } = httpErrorOf(Cause.squash(exit.cause));
  if (status >= 500) logError("sse", `refused (${code}):`, message);
  return Response.json({ ...details, code, message } satisfies StreamErrorBody, { status });
}
