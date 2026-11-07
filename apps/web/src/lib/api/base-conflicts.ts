import type { BaseConflictFrame, BaseConflictsCheck } from "@revv/shared";
import { api } from "$lib/api/client";
import { call } from "$lib/api/errors";
import { SseHttpError, sseErrorMessage, streamSse } from "$lib/api/sse-stream";
import { thrownMessage } from "$lib/api/wire";

export async function fetchBaseConflicts(
  prId: string,
  force: boolean,
): Promise<{ ok: true; check: BaseConflictsCheck } | { ok: false; message: string }> {
  try {
    const check = await call(
      api.api.prs({ id: prId })["base-conflicts"].get({ query: force ? { force: "1" } : {} }),
      "Couldn't check for conflicts",
    );
    return { ok: true, check };
  } catch (e) {
    return { ok: false, message: thrownMessage(e) };
  }
}

export interface ResolveCallbacks {
  readonly onFrame: (frame: BaseConflictFrame) => void;
  /** The run was refused, or the connection died before a `result` frame. */
  readonly onError: (message: string) => void;
  readonly signal?: AbortSignal;
}

/**
 * Start "Resolve with agent" and stream its frames. The run carries on on
 * the server if the stream drops; a re-check then tells the UI where it ended.
 */
export async function streamBaseConflictResolve(
  prId: string,
  expectedHeadSha: string,
  callbacks: ResolveCallbacks,
): Promise<void> {
  let sawResult = false;
  try {
    await streamSse<BaseConflictFrame>({
      path: `/api/prs/${prId}/base-conflicts/resolve`,
      method: "POST",
      body: { expectedHeadSha },
      ...(callbacks.signal ? { signal: callbacks.signal } : {}),
      onEvent: (frame) => {
        if (frame.kind === "result") sawResult = true;
        callbacks.onFrame(frame);
      },
    });
  } catch (e) {
    const message = sseErrorMessage(e, "Couldn't start");
    if (callbacks.signal?.aborted || message === null) return;
    if (e instanceof SseHttpError || !sawResult) callbacks.onError(message);
    return;
  }
  if (!sawResult) callbacks.onError("Lost the connection before the run finished");
}
