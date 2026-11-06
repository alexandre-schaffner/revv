import { ACP_AGENT_IDS, type AgentCheckResult } from "@revv/shared";
import { Effect } from "effect";
import { Elysia, t } from "elysia";
import { resolveGenerationModel } from "../ai/acp/presets";
import { checkAgent } from "../ai/providers/agent-check";
import { SettingsService } from "../services/Settings";
import { runRoute, withAuth } from "./middleware";
import { literalUnion } from "./schemas";

/**
 * Settings' "Test agent" button: one real turn with the configured review
 * model (see `checkAgent`). Behind auth because, unlike the rest of Settings,
 * it spends tokens. Explicit user action only, so opening Settings never
 * starts an agent or a Keychain prompt.
 */
export const agentCheckRoutes = new Elysia().use(withAuth).post(
  "/api/agent/check",
  (ctx) =>
    runRoute(
      Effect.gen(function* () {
        const { agent } = ctx.body;
        const settings = yield* Effect.flatMap(SettingsService, (s) => s.getSettings());
        const model = resolveGenerationModel(agent, settings.aiModel);
        if (!model) {
          return {
            ok: false,
            error: "No model is configured for this agent.",
            guidance: null,
          } satisfies AgentCheckResult;
        }
        return yield* Effect.promise(() => checkAgent({ agent, model, cwd: process.cwd() }));
      }),
    ),
  { body: t.Object({ agent: literalUnion(ACP_AGENT_IDS) }) },
);
