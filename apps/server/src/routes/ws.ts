import type { WsClientMessage } from "@revv/shared";
import { Effect } from "effect";
import { Elysia } from "elysia";
import { AppRuntime } from "../runtime";
import { Identity } from "../services/Identity";
import { PollScheduler } from "../services/PollScheduler";
import { WebSocketHub } from "../services/WebSocketHub";

/** Server-side ping interval (30s) for dead-connection detection (W1). */
const WS_PING_INTERVAL_MS = 30_000;

export const wsRoute = new Elysia().ws("/ws", {
  async open(ws) {
    // Authenticate via token query param or cookie
    const token = ws.data.query?.token as string | undefined;
    if (!token) {
      ws.close(4001, "Unauthorized");
      return;
    }

    // Validate the bearer token with Better Auth
    const headers = new Headers({ Authorization: `Bearer ${token}` });
    const session = await AppRuntime.runPromise(
      Effect.flatMap(Identity, (identity) =>
        Effect.promise(() => identity.sessionFromHeaders(headers)),
      ),
    );
    if (!session) {
      ws.close(4001, "Unauthorized");
      return;
    }

    // Resolve the active account from the host the frontend is targeting.
    const host = (ws.data.query?.host as string | undefined) || undefined;
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
      ws.close(4001, "Unauthorized");
      return;
    }

    await AppRuntime.runPromise(
      Effect.flatMap(WebSocketHub, (hub) => hub.register(ws.raw, accountId)),
    );

    // Server-driven ping every 30s so proxies / NAT / OS sleep don't leave
    // the client on a dead socket. Bun's ws.ping() sends a Ping frame; the
    // browser auto-responds with Pong, so this costs one tiny frame per 30s.
    // No client-side handling needed — the browser maintains the TCP keepalive
    // semantics for us.
    const pingInterval = setInterval(() => {
      try {
        ws.ping();
      } catch {
        /* socket already dead — clearInterval below handles cleanup */
        clearInterval(pingInterval);
      }
    }, WS_PING_INTERVAL_MS);

    // Clean up on close so the interval doesn't fire on a dead socket.
    // The close handler is async but we need to clear before the browser
    // delivers the close frame, so we store the interval id on ws.data.
    (ws.data as Record<string, unknown>).pingInterval = pingInterval;

    // PollScheduler is started on server boot (see `index.ts`) so that
    // background sync runs even when the Tauri window is closed to the
    // tray. No client-side start needed here.
  },

  async close(ws) {
    // Clear the ping interval before unregistering so no stale timers fire.
    const data = ws.data as Record<string, unknown>;
    if (data.pingInterval) {
      clearInterval(data.pingInterval as ReturnType<typeof setInterval>);
      data.pingInterval = null;
    }
    await AppRuntime.runPromise(Effect.flatMap(WebSocketHub, (hub) => hub.unregister(ws.raw)));
  },

  async message(_ws, msg) {
    let parsed: WsClientMessage;
    try {
      parsed = JSON.parse(typeof msg === "string" ? msg : JSON.stringify(msg)) as WsClientMessage;
    } catch {
      return;
    }

    if (parsed.type === "prs:request-sync") {
      await AppRuntime.runPromise(Effect.flatMap(PollScheduler, (s) => s.syncNow()));
    } else if (parsed.type === "threads:request-sync") {
      const prId = parsed.data.prId;
      await AppRuntime.runPromise(
        Effect.flatMap(PollScheduler, (s) => s.syncThreadsNow(prId)),
      ).catch(() => {
        /* best-effort */
      });
    }
  },
});
