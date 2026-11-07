// The client for the server's fetch-SSE streams. The server heartbeats every
// one of them (`routes/sse.ts`), so a stretch with no bytes at all means the
// connection is dead, not that the agent is thinking. A silent close (server
// crash, the OS reclaiming the WKWebView socket) never resolves a pending
// read, so only a timer can notice it.

import {
  SSE_DONE_DATA,
  SSE_ERROR_EVENT,
  type StreamErrorBody,
  type StreamErrorCode,
} from "@revv/shared";
import { API_BASE_URL } from "$lib/api/base-url";
import { bodyMessage } from "$lib/api/errors";
import { authHeaders } from "$lib/session/token.svelte";

const DEFAULT_IDLE_TIMEOUT_MS = 90 * 1000;

interface SseStreamOptions<T> {
  readonly path: string;
  readonly method?: "GET" | "POST";
  readonly body?: unknown;
  readonly signal?: AbortSignal;
  /** Abort with {@link SseIdleError} after this long without a byte. */
  readonly idleTimeoutMs?: number;
  /** Awaited before the next frame is delivered when it returns a promise. */
  readonly onEvent: (event: T) => void | Promise<void>;
}

/** The server answered with a non-2xx status before streaming. */
export class SseHttpError extends Error {
  override readonly name = "SseHttpError";
  readonly body: unknown;
  readonly serverMessage: string | undefined;

  constructor(
    readonly status: number,
    readonly statusText: string,
    body: unknown,
  ) {
    const serverMessage = bodyMessage(body);
    super(serverMessage ?? `HTTP ${status}`);
    this.body = body;
    this.serverMessage = serverMessage;
  }
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
 * left unterminated at close is still delivered. Rejects with
 * {@link SseHttpError}, {@link SseFrameError}, {@link SseIdleError}, the
 * signal's `AbortError`, or the fetch's own network error.
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
      throw new SseHttpError(res.status, res.statusText, parseJson(text));
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * How a {@link streamSse} call ended badly, as an `event: error` frame's
 * `{ code, message }` body: the server's refusal (an `ApiErrorBody`), its
 * `event: error` frame, or the client's own transport failure. Null when the
 * caller aborted it. `fallback` words a refusal whose body says nothing.
 */
export function sseError(err: unknown, fallback: string): StreamErrorBody | null {
  if (err instanceof SseHttpError) {
    const message = err.serverMessage ?? `${fallback} (HTTP ${err.status})`;
    if (!isRecord(err.body) || typeof err.body.code !== "string")
      return { code: "UNKNOWN", message };
    const { error: _error, ...details } = err.body;
    return { ...details, code: err.body.code as StreamErrorCode, message };
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
export function sseErrorMessage(err: unknown, fallback: string): string | null {
  return sseError(err, fallback)?.message ?? null;
}

function frameError(raw: string): SseFrameError {
  const payload = parseJson(raw) as { code?: unknown; message?: unknown } | null;
  return typeof payload?.message === "string"
    ? new SseFrameError(
        typeof payload.code === "string" ? (payload.code as StreamErrorCode) : "UNKNOWN",
        payload.message,
      )
    : new SseFrameError("PARSE_ERROR", "Failed to parse error");
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
