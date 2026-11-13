// `GET /api/events` — one long-lived SSE connection per client tab carrying
// the server pushes for every GitHub account of the signed-in user.
//
// Auth: `?token=<bearer>`, because the browser's `EventSource` API does not
// allow custom headers.
//
// Reconnect: native `EventSource` auto-reconnects with `Last-Event-ID`, but
// the server does NOT replay missed events — the client reconciles via REST
// snapshots (`/api/walkthroughs/active`, `/current`), which return `seqAt`
// cursors (invariant 8).

import type { ServerEventMessage } from "@revv/shared";
import { Effect } from "effect";
import { Elysia } from "elysia";
import { debug } from "../logger";
import { AppRuntime } from "../runtime";
import { Broadcaster } from "../services/Broadcaster";
import { authenticate } from "./middleware";
import { openSse } from "./sse";

export const eventsRoute = new Elysia().get("/api/events", async ({ query, request }) => {
  const auth = await authenticate(typeof query.token === "string" ? query.token : undefined);
  if (!("userId" in auth)) return auth;
  const { userId } = auth;

  const { response, channel } = openSse<ServerEventMessage>({
    heartbeat: "event",
    signal: request.signal,
  });
  const unregister = await AppRuntime.runPromise(
    Effect.flatMap(Broadcaster, (bus) => bus.register(userId, channel)),
  );
  channel.onClose(unregister);

  debug("events-route", `connected userId=${userId}`);
  return response;
});
