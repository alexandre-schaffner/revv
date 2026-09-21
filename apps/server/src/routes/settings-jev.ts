// ── TypeSafe System One key management ─────────────────────────────────────
//
// Composed into `settingsRoutes` via `.use()`. Every route here is
// individually `withAuth`-guarded: the parent settings router is mounted
// without auth, which is exactly why the key never enters its DTO.

import { Elysia, t } from "elysia";
import { clearJevApiKey, setJevApiKey } from "../ai/jev/api-key";
import { AppRuntime } from "../runtime";
import { handleAppError, withAuth } from "./middleware";

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
  });
