// ── TypeSafe System One key management ─────────────────────────────────────
//
// Composed into `settingsRoutes` via `.use()`. Every route here is
// individually `withAuth`-guarded, unlike the unauthenticated parent — why the key never enters its DTO.

import { Effect } from "effect";
import { Elysia, t } from "elysia";
import { clearJevApiKey, setJevApiKey } from "../ai/jev/api-key";
import type { JevUnavailableReason } from "../domain/errors";
import { AppRuntime } from "../runtime";
import { JevService } from "../services/Jev";
import { handleAppError, withAuth } from "./middleware";

/** Human-readable cause for the Settings "Test connection" result. */
const TEST_FAILURE_MESSAGE: Record<JevUnavailableReason, string> = {
  unconfigured: "No API key saved.",
  disabled: "TypeSafe is turned off.",
  timeout: "The request timed out.",
  transport: "Could not reach the TypeSafe API.",
  malformed: "The API returned an unexpected response.",
};

export const settingsJevRoutes = new Elysia()
  .use(withAuth)
  .put(
    "/jev/api-key",
    async (ctx) => {
      try {
        const hasApiKey = await AppRuntime.runPromise(setJevApiKey(ctx.body.apiKey));
        return { hasApiKey };
      } catch (e) {
        return handleAppError(e, ctx);
      }
    },
    { body: t.Object({ apiKey: t.String() }) },
  )
  .delete("/jev/api-key", async (ctx) => {
    try {
      await AppRuntime.runPromise(clearJevApiKey);
      return { hasApiKey: false };
    } catch (e) {
      return handleAppError(e, ctx);
    }
  })
  // Lets the user tell a bad key from a bad network without generating a
  // walkthrough. Mirrors `/cache/signing/test`: failures return `{ ok: false, error }`, not a non-2xx.
  .post("/jev/test", async (ctx) => {
    try {
      return await AppRuntime.runPromise(
        Effect.flatMap(JevService, (jev) => jev.testConnection()).pipe(
          Effect.map((r) => ({ ok: true as const, model: r.model, latencyMs: r.latencyMs })),
          Effect.catchTag("JevUnavailable", (e) =>
            Effect.succeed({
              ok: false as const,
              error: e.message || TEST_FAILURE_MESSAGE[e.reason],
            }),
          ),
        ),
      );
    } catch (e) {
      return handleAppError(e, ctx);
    }
  });
