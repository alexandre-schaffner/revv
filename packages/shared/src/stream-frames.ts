import type { ApiErrorCode } from "./api-errors";

// The chat turn, push-resolution, base-conflict and review streams send one
// `data: <json>` frame per item, end with a `data: [DONE]` frame, and report
// a failure mid-stream as an `event: error` frame. A request refused before
// its stream starts answers with a JSON body instead. Either failure carries
// one of the codes below; the client branches on the code, never on the
// message.

export const SSE_DONE_DATA = "[DONE]";
export const SSE_ERROR_EVENT = "error";

export const SSE_DONE_FRAME = `data: ${SSE_DONE_DATA}\n\n`;

export function sseErrorFrame(body: StreamErrorBody): string {
  return `event: ${SSE_ERROR_EVENT}\ndata: ${JSON.stringify(body)}\n\n`;
}

export type StreamErrorCode =
  // An API error: refused before the stream starts, or `GENERATION_ERROR`
  // mid-stream.
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
