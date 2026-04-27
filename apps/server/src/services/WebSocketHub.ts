import type { WsServerMessage } from "@revv/shared";
import { Context, Effect, Layer, Ref } from "effect";

// Use `any` to avoid Bun type conflicts — we only call .send(string) in practice
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type BunServerWebSocket = any;

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
