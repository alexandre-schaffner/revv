import {
  ACP_AGENT_IDS,
  type AcpAgentId,
  isAcpAgentId,
  isSettingField,
  SETTINGS_SPEC,
  type SettingField,
  type SettingsSpecNode,
  type SettingsUpdate,
  type SettingWire,
  type UserSettings,
} from "@revv/shared";
import { Effect } from "effect";
import { Elysia, type TSchema, t } from "elysia";
import { listAgentModels } from "../ai/acp/agents";
import { clearJevApiKey, hasJevApiKey, setJevApiKey } from "../ai/jev/api-key";
import type { JevUnavailableReason } from "../domain/errors";
import { JevService } from "../services/Jev";
import { SettingsService } from "../services/Settings";
import { runRoute, withAuth } from "./middleware";
import { literalUnion } from "./schemas";
import { teamCacheRoutes } from "./team-cache";

/**
 * Overlay the server-derived `jev.hasApiKey` onto a settings DTO.
 *
 * The key lives in the keyring, never in `user_settings`: settings are
 * readable without a session.
 */
const withJevKeyState = (settings: UserSettings) =>
  Effect.map(
    hasJevApiKey,
    (present): UserSettings => ({ ...settings, jev: { ...settings.jev, hasApiKey: present } }),
  );

/** The request schema for a settings patch, built from the shared spec; derived fields are left out. */
function patchSchemaOf(group: Exclude<SettingsSpecNode, SettingField<unknown>>): TSchema {
  const properties: Record<string, TSchema> = {};
  for (const [key, child] of Object.entries(group)) {
    const schema = isSettingField(child) ? fieldSchemaOf(child.wire) : patchSchemaOf(child);
    if (schema) properties[key] = schema;
  }
  return t.Partial(t.Object(properties));
}

function fieldSchemaOf(wire: SettingWire): TSchema | null {
  switch (wire.type) {
    case "string":
      return wire.minLength === undefined ? t.String() : t.String({ minLength: wire.minLength });
    case "enum":
      return literalUnion(wire.values);
    case "number":
      return t.Number({
        ...(wire.minimum === undefined ? {} : { minimum: wire.minimum }),
        ...(wire.maximum === undefined ? {} : { maximum: wire.maximum }),
      });
    case "boolean":
      return t.Boolean();
    case "string[]":
      return t.Array(t.String());
    case "derived":
      return null;
  }
}

const TEST_FAILURE_MESSAGE: Record<JevUnavailableReason, string> = {
  unconfigured: "No API key saved.",
  disabled: "TypeSafe is turned off.",
  timeout: "The request timed out.",
  rate_limited: "The API key is over its request quota; try again shortly.",
  transport: "Could not reach the TypeSafe API.",
  malformed: "The API returned an unexpected response.",
};

const settingsPatchSchema = t.Unsafe<SettingsUpdate>(patchSchemaOf(SETTINGS_SPEC));

const githubConfigSchema = t.Unsafe<Pick<UserSettings, "githubHost" | "githubClientId">>(
  t.Object({
    githubHost: fieldSchemaOf(SETTINGS_SPEC.githubHost.wire) ?? t.String(),
    githubClientId: fieldSchemaOf(SETTINGS_SPEC.githubClientId.wire) ?? t.String(),
  }),
);

const getSettings = () =>
  runRoute(
    Effect.flatMap(SettingsService, (s) => s.getSettings()).pipe(Effect.flatMap(withJevKeyState)),
  );

// Only persists: reactions to a change subscribe to `SettingsService.watch`.
const putSettings = (patch: SettingsUpdate) =>
  runRoute(
    Effect.flatMap(SettingsService, (s) => s.updateSettings(patch)).pipe(
      Effect.flatMap(withJevKeyState),
    ),
  );

/**
 * What onboarding needs before anyone has signed in: the settings read, and
 * the GitHub host and client id that sign-in itself depends on.
 */
const openSettingsRoutes = new Elysia({ prefix: "/api/settings" })
  .get("/", getSettings)
  .put("/github", (ctx) => putSettings(ctx.body), { body: githubConfigSchema });

const signedInSettingsRoutes = new Elysia({ prefix: "/api/settings" })
  .use(withAuth)
  .put("/", (ctx) => putSettings(ctx.body), { body: settingsPatchSchema })
  .get(
    "/models",
    (ctx) =>
      runRoute(
        Effect.gen(function* () {
          const agentParam = ctx.query?.agent;
          const agent: AcpAgentId =
            agentParam && isAcpAgentId(agentParam)
              ? agentParam
              : yield* Effect.flatMap(SettingsService, (s) => s.resolveAgent());
          const models = yield* Effect.promise(() => listAgentModels(agent));
          return { models, agent };
        }),
      ),
    {
      query: t.Optional(
        t.Object({
          agent: t.Optional(literalUnion(ACP_AGENT_IDS)),
        }),
      ),
    },
  )
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

export const settingsRoutes = new Elysia()
  .use(openSettingsRoutes)
  .use(signedInSettingsRoutes)
  .use(teamCacheRoutes);
