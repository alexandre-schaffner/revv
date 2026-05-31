// ── Global SSE stream ───────────────────────────────────────────────────────
//
// `GET /api/events` — one long-lived SSE connection per client tab carrying
// account-scoped server pushes. Replaces the per-PR walkthrough SSE for the
// walkthrough subsystem (other channels keep using the WS for now and migrate
// in follow-up PRs).
//
// Auth: `?token=<bearer>` query param, mirroring `routes/ws.ts`. Cannot use
// the `Authorization` header because the browser's `EventSource` API does
// not allow custom headers.
//
// Reconnect: native `EventSource` auto-reconnects with `Last-Event-ID`. The
// server does NOT replay missed events on reconnect — the client reconciles
// via REST snapshots (`/api/walkthroughs/active`, `/current`) which return
// `seqAt` cursors. `Last-Event-ID` is therefore informational only. See
// the SSE-rewrite plan §4.2 for rationale.

import { Effect } from "effect";
import { Elysia } from "elysia";
import { debug, logError } from "../logger";
import { AppRuntime } from "../runtime";
import {
  Broadcaster,
  type EventWriter,
  encodeSseFrame,
  encodeSseHeartbeat,
} from "../services/Broadcaster";
import { Identity } from "../services/Identity";

const HEARTBEAT_INTERVAL_MS = 15_000;

export const eventsRoute = new Elysia().get("/api/events", async ({ query, request }) => {
  // ── Auth ────────────────────────────────────────────────────────────────
  const token = typeof query.token === "string" ? query.token : undefined;
  if (!token) {
    return new Response("Unauthorized", { status: 401 });
  }

  const headers = new Headers({ Authorization: `Bearer ${token}` });
  const session = await AppRuntime.runPromise(
    Effect.flatMap(Identity, (identity) =>
      Effect.promise(() => identity.sessionFromHeaders(headers)),
    ),
  );
  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }

  // ── Resolve account ─────────────────────────────────────────────────────
  const host = typeof query.host === "string" ? query.host : undefined;
  let accountId: string;
  try {
    const resolved = await AppRuntime.runPromise(
      Effect.gen(function* () {
        const identity = yield* Identity;
        return yield* identity.resolveAccount(session.user.id, host);
      }),
    );
    accountId = resolved.accountId;
  } catch {
    // Parity with the WS route: an unresolvable account opens an
    // observer-only connection that never receives scoped broadcasts.
    accountId = "unresolved";
  }

  // ── Build the stream + writer ───────────────────────────────────────────
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  let unregister: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const tearDown = (): void => {
    if (closed) return;
    closed = true;
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    if (unregister) {
      try {
        unregister();
      } catch {
        // Best-effort cleanup; the bus is forgiving.
      }
      unregister = null;
    }
    try {
      controller.close();
    } catch {
      // Already closed — fine.
    }
  };

  const tryEnqueue = (bytes: Uint8Array): boolean => {
    if (closed) return false;
    try {
      controller.enqueue(bytes);
      return true;
    } catch (err) {
      logError(
        "events-route",
        `enqueue-failed bytes=${bytes.byteLength}:`,
        err instanceof Error ? err.message : String(err),
      );
      tearDown();
      return false;
    }
  };

  const writer: EventWriter = {
    send: (event) => tryEnqueue(encodeSseFrame(event)),
    isClosed: () => closed,
  };

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      tearDown();
    },
  });

  // Register with the broadcaster AFTER `controller` is captured so the
  // writer's `send` never races a pre-start broadcast.
  unregister = await AppRuntime.runPromise(
    Effect.flatMap(Broadcaster, (bus) => bus.register(accountId, writer)),
  );

  // Heartbeat so Tauri webviews / proxies don't drop the connection during
  // quiet windows (no walkthroughs running, etc.).
  heartbeat = setInterval(() => {
    tryEnqueue(encodeSseHeartbeat());
  }, HEARTBEAT_INTERVAL_MS);

  // Best-effort: tear down when the underlying fetch is aborted. Bun forwards
  // client disconnects through `request.signal` for the HTTP/1.1 response
  // streaming path, so this is the symmetric counterpart to the WS `close`
  // hook. Not all environments reliably fire this — the ReadableStream
  // `cancel()` callback above is the authoritative fallback.
  request.signal.addEventListener("abort", tearDown, { once: true });

  debug("events-route", `connected accountId=${accountId}`);

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      // Disable buffering for any reverse proxy in the path; harmless for direct dev.
      "X-Accel-Buffering": "no",
    },
  });
});
