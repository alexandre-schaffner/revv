// SSE subscription to the collector's `/events` signal stream. The payload is
// a signal, not state: on each `perf:updated` (and on reconnect) the caller
// re-queries the REST endpoints. EventSource handles reconnect with backoff.

export interface SseHandlers {
  onUpdate: (data: { ingested: number; latestMs: number }) => void;
  onStatus: (connected: boolean) => void;
}

export function subscribePerf(handlers: SseHandlers): () => void {
  const source = new EventSource("/events");

  source.addEventListener("open", () => handlers.onStatus(true));
  source.addEventListener("error", () => handlers.onStatus(false));
  source.addEventListener("perf:updated", (ev) => {
    try {
      handlers.onUpdate(JSON.parse((ev as MessageEvent).data));
    } catch {
      handlers.onUpdate({ ingested: 0, latestMs: 0 });
    }
  });

  return () => source.close();
}
