import type { ApiErrorCode } from "./api-errors";

// The chat turn, push-resolution, base-conflict and review streams send one
// `data: <json>` frame per item, end with a `data: [DONE]` frame, and report
// a failure mid-stream as an `event: error` frame (`StreamErrorBody`). A
// request refused before its stream starts is refused like any REST request,
// with an `ApiErrorBody`. The client branches on the code, never on the
// message.

export const SSE_DONE_DATA = "[DONE]";
export const SSE_ERROR_EVENT = "error";

export const SSE_DONE_FRAME = `data: ${SSE_DONE_DATA}\n\n`;

/**
 * Every stream heartbeats this often. The browser's `EventSource` never
 * surfaces `:` comments, so the global stream heartbeats with a named event;
 * its client counts a connection dead after a few missed beats.
 */
export const SSE_HEARTBEAT_INTERVAL_MS = 15_000;
export const SSE_HEARTBEAT_EVENT = "heartbeat";

export function sseErrorFrame(body: StreamErrorBody): string {
  return `event: ${SSE_ERROR_EVENT}\ndata: ${JSON.stringify(body)}\n\n`;
}

export type StreamErrorCode =
  // An API error mid-stream, or `GENERATION_ERROR`.
  | ApiErrorCode
  // The client's own transport failures.
  | "NETWORK_ERROR"
  | "NO_BODY"
  | "UNKNOWN"
  | "PARSE_ERROR";

export interface StreamErrorBody {
  readonly code: StreamErrorCode;
  readonly message: string;
  /** Code-specific details, e.g. the blocked commits of `WORKTREE_BLOCKED`. */
  readonly [detail: string]: unknown;
}
