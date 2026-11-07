// The client for the server's fetch-SSE streams. The server heartbeats every
// one of them (`routes/sse.ts`), so a stretch with no bytes at all means the
// connection is dead, not that the agent is thinking. A silent close (server
// crash, the OS reclaiming the WKWebView socket) never resolves a pending
// read, so only a timer can notice it.

import {
  isApiErrorCode,
  SSE_DONE_DATA,
  SSE_ERROR_EVENT,
  type StreamErrorBody,
  type StreamErrorCode,
} from "@revv/shared";
import { API_BASE_URL } from "$lib/api/base-url";
import { ApiError } from "$lib/api/errors";
import { authHeaders } from "$lib/session/token.svelte";

const DEFAULT_IDLE_TIMEOUT_MS = 90 * 1000;

interface SseStreamOptions<T> {
  readonly path: string;
  readonly method?: "GET" | "POST";
  readonly body?: unknown;
  readonly signal?: AbortSignal;
  /** Words a refusal whose body says nothing, like `call`'s fallback. */
  readonly refused: string;
  /** Abort with {@link SseIdleError} after this long without a byte. */
  readonly idleTimeoutMs?: number;
  /** Awaited before the next frame is delivered when it returns a promise. */
  readonly onEvent: (event: T) => void | Promise<void>;
}

/** The server ended the stream with an `event: error` frame. */
export class SseFrameError extends Error {
  override readonly name = "SseFrameError";

  constructor(
    readonly code: StreamErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export class SseIdleError extends Error {
  override readonly name = "SseIdleError";

  constructor(readonly timeoutMs: number) {
    super(`No data from the server for ${Math.round(timeoutMs / 1000)} seconds`);
  }
}

/**
 * Open the stream and deliver each `data:` frame to `onEvent`, in order.
 * Resolves when the server sends `data: [DONE]` or closes the stream; a frame
 * left unterminated at close is still delivered. Rejects with an
 * {@link ApiError} when the server refused before streaming, an
 * {@link SseFrameError}, an {@link SseIdleError}, the signal's `AbortError`,
 * or the fetch's own network error.
 */
export async function streamSse<T>(opts: SseStreamOptions<T>): Promise<void> {
  const controller = new AbortController();
  const forwardAbort = (): void => controller.abort();
  if (opts.signal?.aborted) forwardAbort();
  opts.signal?.addEventListener("abort", forwardAbort, { once: true });

  const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTripped = false;
  const armIdle = (): void => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTripped = true;
      controller.abort();
    }, idleTimeoutMs);
  };

  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    armIdle();
    const headers: Record<string, string> = authHeaders();
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(`${API_BASE_URL}${opts.path}`, {
      method: opts.method ?? "GET",
      headers,
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ApiError({ status: res.status, value: parseJson(text) }, opts.refused);
    }
    if (!res.body) throw new Error("No response body");

    reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      buffer += done ? `${decoder.decode()}\n\n` : decoder.decode(value, { stream: true });
      if (value && value.byteLength > 0) armIdle();

      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        if (frame.startsWith(":")) continue;
        const lines = frame.split("\n");
        const data = lines.filter((l) => l.startsWith("data: ")).map((l) => l.slice(6));
        if (lines.includes(`event: ${SSE_ERROR_EVENT}`)) {
          if (data[0] !== undefined) throw frameError(data[0]);
          continue;
        }
        for (const raw of data) {
          if (raw === SSE_DONE_DATA) return;
          const event = parseJson(raw);
          if (event === null) continue;
          const pending = opts.onEvent(event as T);
          if (pending) await pending;
        }
      }
      if (done) return;
    }
  } catch (err) {
    if (idleTripped) throw new SseIdleError(idleTimeoutMs);
    throw err;
  } finally {
    clearTimeout(idleTimer);
    opts.signal?.removeEventListener("abort", forwardAbort);
    reader?.cancel().catch(() => {});
  }
}

const LOST_CONNECTION_MESSAGE =
  "Lost connection to the local server. The agent may have stopped — check the server logs and try again.";

/**
 * How a {@link streamSse} call ended badly, as the server's `{ code, message }`
 * body: its refusal, its `event: error` frame, or the client's own transport
 * failure. Null when the caller aborted it.
 */
export function sseError(err: unknown): StreamErrorBody | null {
  if (err instanceof ApiError) {
    return err.code !== null
      ? { ...err.body, code: err.code, message: err.message }
      : { code: "UNKNOWN", message: err.message };
  }
  if (err instanceof SseFrameError) return { code: err.code, message: err.message };
  if (err instanceof SseIdleError)
    return { code: "NETWORK_ERROR", message: LOST_CONNECTION_MESSAGE };
  if (!(err instanceof Error)) return { code: "NETWORK_ERROR", message: String(err) };
  if (err.name === "AbortError") return null;
  // WebKit surfaces connection drops as "Load failed"; Chromium as "Failed to fetch".
  const isConnectionDrop = err.message === "Load failed" || err.message === "Failed to fetch";
  return {
    code: "NETWORK_ERROR",
    message: isConnectionDrop ? LOST_CONNECTION_MESSAGE : err.message,
  };
}

/** {@link sseError}'s message; null when the caller aborted the stream. */
export function sseErrorMessage(err: unknown): string | null {
  return sseError(err)?.message ?? null;
}

function frameError(raw: string): SseFrameError {
  const payload = parseJson(raw) as { code?: unknown; message?: unknown } | null;
  return typeof payload?.message === "string"
    ? new SseFrameError(isApiErrorCode(payload.code) ? payload.code : "UNKNOWN", payload.message)
    : new SseFrameError("PARSE_ERROR", "Failed to parse error");
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
