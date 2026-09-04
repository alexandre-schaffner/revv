// ── SSE hub ──────────────────────────────────────────────────────────────────
//
// A minimal fan-out for the dashboard's `/events` stream. The collector runs on
// localhost in dev only, so there's no auth and no account scoping — every
// connected dashboard tab gets every signal.
//
// Discipline mirrors the main app: commit first (DB upsert), broadcast second.
// The push is a *signal*, not state; a tab that reconnects after a missed frame
// reconciles by re-querying the REST endpoints.

import type { PerfUpdatedEvent } from "./shared/types";

const HEARTBEAT_MS = 15_000;
const encoder = new TextEncoder();

interface Client {
  enqueue: (bytes: Uint8Array) => boolean;
  close: () => void;
}

const clients = new Set<Client>();

function frame(event: PerfUpdatedEvent): Uint8Array {
  return encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
}

/** Push a signal to every connected dashboard. Best-effort; dead clients drop. */
export function broadcast(event: PerfUpdatedEvent): void {
  for (const client of clients) {
    if (!client.enqueue(frame(event))) {
      clients.delete(client);
      client.close();
    }
  }
}

/** Build the SSE Response for one `/events` connection. */
export function openStream(signal: AbortSignal): Response {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let client: Client;

  const tearDown = (): void => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    clients.delete(client);
    try {
      controller.close();
    } catch {}
  };

  client = {
    enqueue: (bytes) => {
      if (closed) return false;
      try {
        controller.enqueue(bytes);
        return true;
      } catch {
        return false;
      }
    },
    close: tearDown,
  };

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      // Opening comment flushes headers so the client's `onopen` fires promptly.
      controller.enqueue(encoder.encode(": connected\n\n"));
      clients.add(client);
      heartbeat = setInterval(() => {
        if (!client.enqueue(encoder.encode(": ping\n\n"))) tearDown();
      }, HEARTBEAT_MS);
    },
    cancel: tearDown,
  });

  signal.addEventListener("abort", tearDown, { once: true });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
