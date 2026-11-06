import { ACP_AGENT_IDS } from "@revv/shared";
import { Effect } from "effect";
import { Elysia, t } from "elysia";
import { agentLaunchFor } from "../ai/acp/agent-launch";
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
        const settings = yield* Effect.flatMap(SettingsService, (s) => s.getSettings());
        const launch = agentLaunchFor(settings, ctx.body.agent, "check");
        return yield* Effect.promise(() => checkAgent(launch));
      }),
    ),
  { body: t.Object({ agent: literalUnion(ACP_AGENT_IDS) }) },
);
