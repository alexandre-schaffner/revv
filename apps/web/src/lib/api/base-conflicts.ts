import type { BaseConflictFrame, BaseConflictsCheck } from "@revv/shared";
import { API_BASE_URL } from "$lib/api/base-url";
import { api } from "$lib/api/client";
import { apiErrorMessage } from "$lib/api/errors";
import { plain, thrownMessage } from "$lib/api/wire";
import { authHeaders } from "$lib/utils/session-token";
import { parseSSEBuffer } from "$lib/utils/sse-parser";

export async function fetchBaseConflicts(
  prId: string,
  force: boolean,
): Promise<{ ok: true; check: BaseConflictsCheck } | { ok: false; message: string }> {
  try {
    const { data, error } = await api.api
      .prs({ id: prId })
      ["base-conflicts"].get({ query: force ? { force: "1" } : {} });
    if (error)
      return { ok: false, message: apiErrorMessage(error, "Couldn't check for conflicts") };
    if (!data || !("status" in data)) return { ok: false, message: "Unexpected response" };
    return { ok: true, check: plain(data) as BaseConflictsCheck };
  } catch (e) {
    return { ok: false, message: thrownMessage(e) };
  }
}

export interface ResolveCallbacks {
  readonly onFrame: (frame: BaseConflictFrame) => void;
  /** The run was refused, or the connection died before a `result` frame. */
  readonly onError: (message: string) => void;
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
    const res = await fetch(`${API_BASE_URL}/api/prs/${prId}/base-conflicts/resolve`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ expectedHeadSha }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { message?: string } | null;
      callbacks.onError(body?.message ?? `Couldn't start (HTTP ${res.status})`);
      return;
    }
    const reader = res.body?.getReader();
    if (!reader) {
      callbacks.onError("No response body");
      return;
    }
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parsed = parseSSEBuffer<BaseConflictFrame>(buffer);
      buffer = parsed.remaining;
      for (const frame of parsed.events) {
        if (frame.kind === "result") sawResult = true;
        callbacks.onFrame(frame);
      }
      if (parsed.error) callbacks.onError(parsed.error.message);
      if (parsed.done) break;
    }
  } catch (e) {
    if (!sawResult) callbacks.onError(thrownMessage(e));
    return;
  }
  if (!sawResult) callbacks.onError("Lost the connection before the run finished");
}
