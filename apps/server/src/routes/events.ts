// ── Global SSE stream ───────────────────────────────────────────────────────
//
// `GET /api/events` — one long-lived SSE connection per client tab carrying
// account-scoped server pushes.
//
// Auth: `?token=<bearer>` query param. Cannot use
// the `Authorization` header because the browser's `EventSource` API does
// not allow custom headers.
//
// Reconnect: native `EventSource` auto-reconnects with `Last-Event-ID`. The
// server does NOT replay missed events on reconnect — the client reconciles
// via REST snapshots (`/api/walkthroughs/active`, `/current`) which return
// `seqAt` cursors. `Last-Event-ID` is therefore informational only. See
// the SSE-rewrite plan §4.2 for rationale.

import type { ServerEventMessage } from "@revv/shared";
import { Effect, Exit } from "effect";
import { Elysia } from "elysia";
import { debug } from "../logger";
import { AppRuntime } from "../runtime";
import { Broadcaster } from "../services/Broadcaster";
import { Identity } from "../services/Identity";
import { requestAccount } from "./middleware";
import { openSse } from "./sse";

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

  // A session with no usable GitHub account still gets the server-global
  // signals: it registers under an account id nothing broadcasts to.
  const account = await AppRuntime.runPromiseExit(requestAccount(session.user.id, query));
  const accountId = Exit.isSuccess(account) ? account.value.accountId : "unresolved";

  const { response, channel } = openSse<ServerEventMessage>({
    heartbeat: "event",
    signal: request.signal,
  });
  const unregister = await AppRuntime.runPromise(
    Effect.flatMap(Broadcaster, (bus) => bus.register(accountId, channel)),
  );
  channel.onClose(unregister);

  debug("events-route", `connected accountId=${accountId}`);
  return response;
});
