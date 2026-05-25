import type { RecapStreamEvent } from "@revv/shared";
import { recordCounter, tracedAsync } from "$lib/observability";
import { authHeaders } from "$lib/utils/session-token";
import { parseSSEBuffer } from "$lib/utils/sse-parser";

const INACTIVITY_TIMEOUT_MS = 90 * 1000;

export interface RunRecapSseOptions {
  readonly url: string;
  readonly signal: AbortSignal;
  readonly onEvents: (events: RecapStreamEvent[]) => void;
}

export async function runRecapSse(opts: RunRecapSseOptions): Promise<void> {
  return tracedAsync("recap.sse.run", {}, () => runRecapSseInner(opts));
}

async function runRecapSseInner(opts: RunRecapSseOptions): Promise<void> {
  const res = await fetch(opts.url, {
    headers: authHeaders(),
    signal: opts.signal,
  });

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    let message = `HTTP ${res.status}`;
    try {
      const body = JSON.parse(text);
      message = body.message ?? body.error ?? message;
    } catch {
      /* use default */
    }
    throw new Error(message);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let lastEventTime = Date.now();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    if (value && value.byteLength > 0) {
      lastEventTime = Date.now();
    }

    buffer += decoder.decode(value, { stream: true });

    const result = parseSSEBuffer<RecapStreamEvent>(buffer, undefined, () => {
      /* ignore parse errors */
    });
    buffer = result.remaining;

    if (result.events.length > 0) {
      opts.onEvents(result.events);
    } else if (Date.now() - lastEventTime > INACTIVITY_TIMEOUT_MS) {
      recordCounter("recap.sse.timeout", undefined);
      throw new Error("Recap stream lost — no data from server for 90 seconds.");
    }

    if (result.done) break;
  }

  if (buffer.trim()) {
    const result = parseSSEBuffer<RecapStreamEvent>(`${buffer}\n\n`);
    if (result.events.length > 0) {
      opts.onEvents(result.events);
    }
  }
}
