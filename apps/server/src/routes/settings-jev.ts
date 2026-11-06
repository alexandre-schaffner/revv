import { Effect } from "effect";
import { Elysia, t } from "elysia";
import { clearJevApiKey, setJevApiKey } from "../ai/jev/api-key";
import type { JevUnavailableReason } from "../domain/errors";
import { JevService } from "../services/Jev";
import { runRoute, withAuth } from "./middleware";

const TEST_FAILURE_MESSAGE: Record<JevUnavailableReason, string> = {
  unconfigured: "No API key saved.",
  disabled: "TypeSafe is turned off.",
  timeout: "The request timed out.",
  rate_limited: "The API key is over its request quota; try again shortly.",
  transport: "Could not reach the TypeSafe API.",
  malformed: "The API returned an unexpected response.",
};

export const settingsJevRoutes = new Elysia()
  .use(withAuth)
  .put(
    "/jev/api-key",
    (ctx) =>
      runRoute(setJevApiKey(ctx.body.apiKey).pipe(Effect.map((hasApiKey) => ({ hasApiKey })))),
    { body: t.Object({ apiKey: t.String() }) },
  )
  .delete("/jev/api-key", () => runRoute(clearJevApiKey.pipe(Effect.as({ hasApiKey: false }))))
  // Lets the user tell a bad key from a bad network without generating a
  // walkthrough. Mirrors `/cache/signing/test`: failures return `{ ok: false, error }`, not a non-2xx.
  .post("/jev/test", () =>
    runRoute(
      Effect.flatMap(JevService, (jev) => jev.testConnection()).pipe(
        Effect.map((r) => ({ ok: true as const, model: r.model, latencyMs: r.latencyMs })),
        Effect.catchTag("JevUnavailable", (e) =>
          Effect.succeed({
            ok: false as const,
            error: e.message || TEST_FAILURE_MESSAGE[e.reason],
          }),
        ),
      ),
    ),
  );
