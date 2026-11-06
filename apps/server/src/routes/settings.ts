import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
import { hasJevApiKey } from "../ai/jev/api-key";
import { listCliModels } from "../ai/providers/cli-models";
import { BlobStore } from "../services/blob/BlobStore";
import { SshSigner } from "../services/cache-signing/index";
import { SettingsService } from "../services/Settings";
import { runRoute, withAccount } from "./middleware";
import { literalUnion } from "./schemas";
import { settingsJevRoutes } from "./settings-jev";

/**
 * Overlay the server-derived `jev.hasApiKey` onto a settings DTO.
 *
 * The key lives in the keyring, never in `user_settings`: this router is
 * mounted without `withAuth`, so anything in the row is world-readable.
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

function findGcloud(): string | null {
  const onPath = Bun.which("gcloud");
  if (onPath) return onPath;
  const candidates = [
    join(homedir(), "google-cloud-sdk", "bin", "gcloud"),
    "/opt/homebrew/bin/gcloud",
    "/usr/local/bin/gcloud",
    "/usr/bin/gcloud",
  ];
  return candidates.find((c) => existsSync(c)) ?? null;
}

/**
 * The credentials file alone isn't proof: `gcloud auth revoke` leaves it in
 * place, so ask gcloud for a token. Without gcloud, the file is all there is.
 */
function isAdcValid(gcloudPath: string | null, adcExists: boolean): boolean {
  if (!gcloudPath) return adcExists;
  const result = spawnSync(gcloudPath, ["auth", "application-default", "print-access-token"], {
    timeout: 5000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return result.status === 0;
}

const settingsPatchSchema = t.Unsafe<SettingsUpdate>(patchSchemaOf(SETTINGS_SPEC));

/** Sign and verify a probe as the requesting account, to check commit signing works. */
const signingTestRoute = new Elysia().use(withAccount).post("/cache/signing/test", (ctx) => {
  const probe = "revv-signing-test";
  return runRoute(
    Effect.gen(function* () {
      const signerSvc = yield* SshSigner;
      const signed = yield* signerSvc.sign(probe, ctx.account.accountId);
      yield* signerSvc.verify(probe, signed.signature, signed.signerHost, signed.signerLogin);
      return {
        ok: true as const,
        signerLogin: signed.signerLogin,
        signerHost: signed.signerHost,
        signatureNamespace: signed.signatureNamespace,
      };
    }).pipe(
      Effect.catch((e) =>
        Effect.succeed({
          ok: false as const,
          error: (e as { message?: string }).message ?? String(e),
        }),
      ),
    ),
  );
});

export const settingsRoutes = new Elysia({ prefix: "/api/settings" })
  .get("/", () =>
    runRoute(
      Effect.flatMap(SettingsService, (s) => s.getSettings()).pipe(Effect.flatMap(withJevKeyState)),
    ),
  )
  // Only persists: reactions to a change subscribe to `SettingsService.watch`.
  .put(
    "/",
    (ctx) =>
      runRoute(
        Effect.flatMap(SettingsService, (s) => s.updateSettings(ctx.body)).pipe(
          Effect.flatMap(withJevKeyState),
        ),
      ),
    { body: settingsPatchSchema },
  )
  // Key management lives in its own sub-router because every route on it is
  // individually `withAuth`-guarded, unlike this one.
  .use(settingsJevRoutes)
  .get("/cache/status", () =>
    runRoute(
      Effect.gen(function* () {
        const blob = yield* BlobStore;
        return yield* blob.status();
      }),
    ),
  )
  .use(signingTestRoute)
  .get("/cache/adc-status", () =>
    runRoute(
      Effect.sync(() => {
        const gcloudPath = findGcloud();
        // An explicit service-account key or path is trusted as configured:
        // service-account JSON keys don't work with `print-access-token`.
        const envPath = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
        if (envPath && existsSync(envPath)) {
          return {
            available: true as const,
            source: "env" as const,
            gcloudFound: gcloudPath !== null,
            gcloudPath,
            adcPath: envPath,
          };
        }
        const adcPath = join(
          homedir(),
          ".config",
          "gcloud",
          "application_default_credentials.json",
        );
        const adcExists = existsSync(adcPath);
        return {
          available: adcExists && isAdcValid(gcloudPath, adcExists),
          source: adcExists ? ("default" as const) : null,
          gcloudFound: gcloudPath !== null,
          gcloudPath,
          adcPath,
        };
      }),
    ),
  )
  .post("/cache/adc-login", () =>
    runRoute(
      Effect.sync(() => {
        const gcloudPath = findGcloud();
        if (!gcloudPath) {
          return {
            started: false as const,
            error: "gcloud CLI not found. Install the Google Cloud SDK first.",
          };
        }
        const proc = Bun.spawn([gcloudPath, "auth", "application-default", "login"], {
          detached: true,
          stdio: ["ignore", "ignore", "ignore"],
        });
        proc.unref();
        return { started: true as const, pid: proc.pid };
      }),
    ),
  )
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
          const models = yield* Effect.promise(() => listCliModels(agent));
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
  );
