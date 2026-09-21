// ── TypeSafe System One key management ─────────────────────────────────────
//
// Composed into `settingsRoutes` via `.use()`. Every route here is
// individually `withAuth`-guarded: the parent settings router is mounted
// without auth, which is exactly why the key never enters its DTO.

import { Effect } from "effect";
import { Elysia, t } from "elysia";
import { clearJevApiKey, setJevApiKey } from "../ai/jev/api-key";
import { AppRuntime } from "../runtime";
import { JevService } from "../services/Jev";
import { handleAppError, withAuth } from "./middleware";

/** Human-readable cause for the Settings "Test connection" result. */
const TEST_FAILURE_MESSAGE: Record<string, string> = {
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
  // One-question round trip so the user can tell a bad key from a bad network
  // without generating a walkthrough. Mirrors `/cache/signing/test`: failures
  // come back as `{ ok: false, error }` rather than a non-2xx, because "your
  // key is wrong" is a result, not a server error.
  .post("/jev/test", async (ctx) => {
    try {
      return await AppRuntime.runPromise(
        Effect.flatMap(JevService, (jev) => jev.testConnection()).pipe(
          Effect.map((r) => ({ ok: true as const, model: r.model, latencyMs: r.latencyMs })),
          Effect.catchTag("JevUnavailable", (e) =>
            Effect.succeed({
              ok: false as const,
              error: e.message ?? TEST_FAILURE_MESSAGE[e.reason] ?? "Unknown failure.",
            }),
          ),
        ),
      );
    } catch (e) {
      return handleAppError(e, ctx);
    }
  });
