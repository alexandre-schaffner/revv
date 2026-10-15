import { type ExternalAgentProvider, isExternalAgentProvider } from "@revv/shared";
import { Effect } from "effect";
import { Elysia } from "elysia";
import { AppRuntime } from "../runtime";
import { ExternalIntegrations } from "../services/ExternalIntegrations";
import { handleAppError, withAccount } from "./middleware";

function parseProvider(value: unknown): ExternalAgentProvider | null {
  return typeof value === "string" && isExternalAgentProvider(value) ? value : null;
}

export const externalIntegrationRoutes = new Elysia({ prefix: "/api/integrations" })
  .use(withAccount)
  .get("/status", async (ctx) => {
    try {
      return await AppRuntime.runPromise(
        Effect.flatMap(ExternalIntegrations, (integrations) =>
          integrations.status(ctx.account.accountId),
        ),
      );
    } catch (error) {
      return handleAppError(error, ctx);
    }
  })
  .post("/:provider/connect", async (ctx) => {
    const provider = parseProvider(ctx.params.provider);
    if (!provider) {
      ctx.set.status = 400;
      return { error: `Unknown integration provider '${ctx.params.provider}'.` };
    }
    try {
      return await AppRuntime.runPromise(
        Effect.flatMap(ExternalIntegrations, (integrations) =>
          integrations.connect({
            accountId: ctx.account.accountId,
            userId: ctx.session.user.id,
            provider,
          }),
        ),
      );
    } catch (error) {
      return handleAppError(error, ctx);
    }
  })
  .delete("/:provider/disconnect", async (ctx) => {
    const provider = parseProvider(ctx.params.provider);
    if (!provider) {
      ctx.set.status = 400;
      return { error: `Unknown integration provider '${ctx.params.provider}'.` };
    }
    try {
      await AppRuntime.runPromise(
        Effect.flatMap(ExternalIntegrations, (integrations) =>
          integrations.disconnect(ctx.account.accountId, provider),
        ),
      );
      return { success: true };
    } catch (error) {
      return handleAppError(error, ctx);
    }
  });
