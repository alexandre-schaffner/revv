import { type ExternalAgentProvider, isExternalAgentProvider } from "@revv/shared";
import { Effect } from "effect";
import { Elysia } from "elysia";
import { ValidationError } from "../domain/errors";
import { ExternalIntegrations } from "../services/ExternalIntegrations";
import { errorResponse, runRoute, withAccount } from "./middleware";

function parseProvider(value: unknown): ExternalAgentProvider | null {
  return typeof value === "string" && isExternalAgentProvider(value) ? value : null;
}

export const externalIntegrationRoutes = new Elysia({ prefix: "/api/integrations" })
  .use(withAccount)
  .get("/status", (ctx) =>
    runRoute(
      Effect.flatMap(ExternalIntegrations, (integrations) =>
        integrations.status(ctx.account.accountId),
      ),
    ),
  )
  .post("/:provider/connect", async (ctx) => {
    const provider = parseProvider(ctx.params.provider);
    if (!provider) {
      return errorResponse(
        new ValidationError({ message: `Unknown integration provider '${ctx.params.provider}'.` }),
      );
    }
    return runRoute(
      Effect.flatMap(ExternalIntegrations, (integrations) =>
        integrations.connect({
          accountId: ctx.account.accountId,
          userId: ctx.session.user.id,
          provider,
        }),
      ),
    );
  })
  .delete("/:provider/disconnect", async (ctx) => {
    const provider = parseProvider(ctx.params.provider);
    if (!provider) {
      return errorResponse(
        new ValidationError({ message: `Unknown integration provider '${ctx.params.provider}'.` }),
      );
    }
    return runRoute(
      Effect.flatMap(ExternalIntegrations, (integrations) =>
        integrations.disconnect(ctx.account.accountId, provider),
      ).pipe(Effect.as({ success: true })),
    );
  });
