// The one client for the server's fetch-SSE streams (chat turns, recaps,
// base-conflict and push-conflict runs, agent install/login). The server
// heartbeats most of them (`: keepalive` / `: ping` every 15 s), so a stretch
// with no bytes at all means the connection is dead, not that the agent is
// thinking. A silent close (server crash, the OS reclaiming the WKWebView
// socket) never resolves a pending read, so only a timer can notice it.

import { API_BASE_URL } from "$lib/api/base-url";
import { authHeaders } from "$lib/session/token.svelte";

const DEFAULT_IDLE_TIMEOUT_MS = 90 * 1000;

interface SseStreamOptions<T> {
  /** Path under the API origin, e.g. `/api/chat`. */
  readonly path: string;
  readonly method?: "GET" | "POST";
  /** Sent as JSON. */
  readonly body?: unknown;
  readonly signal?: AbortSignal;
  /**
   * Abort with {@link SseIdleError} after this long without a byte. `null`
   * for streams the server doesn't heartbeat, where a quiet stretch is normal.
   */
  readonly idleTimeoutMs?: number | null;
  /** Awaited before the next frame is delivered when it returns a promise. */
  readonly onEvent: (event: T) => void | Promise<void>;
}

/** The server answered with a non-2xx status before streaming. */
export class SseHttpError extends Error {
  override readonly name = "SseHttpError";
  /** The parsed JSON body, or `null` when there wasn't one. */
  readonly body: unknown;
  /** The body's `message` or `error` string, when it carries one. */
  readonly serverMessage: string | undefined;

  constructor(
    readonly status: number,
    readonly statusText: string,
    body: unknown,
  ) {
    const serverMessage = messageOf(body);
    super(serverMessage ?? `HTTP ${status}`);
    this.body = body;
    this.serverMessage = serverMessage;
  }
}

/** The server ended the stream with an `event: error` frame. */
export class SseFrameError extends Error {
  override readonly name = "SseFrameError";

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** No bytes arrived within the idle timeout. */
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

  const idleTimeoutMs =
    opts.idleTimeoutMs === undefined ? DEFAULT_IDLE_TIMEOUT_MS : opts.idleTimeoutMs;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTripped = false;
  const armIdle = (): void => {
    if (idleTimeoutMs === null) return;
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
      // A frame the server left unterminated before closing still counts.
      buffer += done ? `${decoder.decode()}\n\n` : decoder.decode(value, { stream: true });
      if (value && value.byteLength > 0) armIdle();

      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        if (frame.startsWith(":")) continue;
        const lines = frame.split("\n");
        const data = lines.filter((l) => l.startsWith("data: ")).map((l) => l.slice(6));
        if (lines.includes("event: error")) {
          if (data[0] !== undefined) throw frameError(data[0]);
          continue;
        }
        for (const raw of data) {
          if (raw === "[DONE]") return;
          const event = parseJson(raw);
          if (event === null) continue;
          const pending = opts.onEvent(event as T);
          if (pending) await pending;
        }
      }
      if (done) return;
    }
  } catch (err) {
    if (idleTripped && idleTimeoutMs !== null) throw new SseIdleError(idleTimeoutMs);
    throw err;
  } finally {
    clearTimeout(idleTimer);
    opts.signal?.removeEventListener("abort", forwardAbort);
    reader?.cancel().catch(() => {});
  }
}

function frameError(raw: string): SseFrameError {
  const payload = parseJson(raw) as { code?: unknown; message?: unknown } | null;
  return typeof payload?.message === "string"
    ? new SseFrameError(
        typeof payload.code === "string" ? payload.code : "UNKNOWN",
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

function messageOf(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const { message, error } = body as { message?: unknown; error?: unknown };
  if (typeof message === "string") return message;
  if (typeof error === "string") return error;
  return undefined;
}
