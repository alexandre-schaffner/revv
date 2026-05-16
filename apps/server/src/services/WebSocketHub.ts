import type { WsServerMessage } from "@revv/shared";
import { Context, Effect, Layer, Ref } from "effect";

/** Narrow contract for WebSocket instances — avoids Bun-vs-ws type conflicts. */
interface BunServerWebSocket {
  send(data: string | ArrayBufferLike | Uint8Array): void;
}

export class WebSocketHub extends Context.Tag("WebSocketHub")<
  WebSocketHub,
  {
    readonly register: (ws: BunServerWebSocket) => Effect.Effect<void>;
    readonly unregister: (ws: BunServerWebSocket) => Effect.Effect<void>;
    readonly broadcast: (msg: WsServerMessage) => Effect.Effect<void>;
    readonly clientCount: Effect.Effect<number>;
  }
>() {}

export const WebSocketHubLive = Layer.effect(
  WebSocketHub,
  Effect.gen(function* () {
    const clients = yield* Ref.make(new Set<BunServerWebSocket>());
    return {
      register: (ws) =>
        Ref.update(clients, (set) => {
          const next = new Set(set);
          next.add(ws);
          return next;
        }),
      unregister: (ws) =>
        Ref.update(clients, (set) => {
          const next = new Set(set);
          next.delete(ws);
          return next;
        }),
      /**
       * Best-effort fire-and-forget broadcast to all connected clients.
       *
       * CONTRACT: Subscribers MUST reconcile from the DB on reconnect — any
       * message missed during a disconnect is permanently lost. Never derive
       * authoritative display state exclusively from WS messages; the DB is
       * always the source of truth. Every feature that introduces a new WS
       * event type must uphold this invariant or it will silently corrupt
       * state for clients that experience even a brief disconnect.
       */
      broadcast: (msg) =>
        Effect.gen(function* () {
          const set = yield* Ref.get(clients);
          const data = JSON.stringify(msg);
          for (const ws of set) {
            try {
              ws.send(data);
            } catch {
              // client disconnected, will be unregistered on close event
            }
          }
        }),
      clientCount: Effect.map(Ref.get(clients), (set) => set.size),
    };
  }),
);
