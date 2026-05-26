import { Effect } from "effect";
import { Elysia, t } from "elysia";
import { listCliModels } from "../ai/providers/cli-agent";
import { AppRuntime } from "../runtime";
import { AiService, resolveAgent } from "../services/Ai";
import { BlobStore } from "../services/blob/BlobStore";
import { SshSigner } from "../services/cache-signing/index";
import { PollScheduler } from "../services/PollScheduler";
import { SettingsService } from "../services/Settings";
import { handleAppError } from "./middleware";
import { updateChannelSchema } from "./schemas";

export const settingsRoutes = new Elysia({ prefix: "/api/settings" })
  .get("/", async (ctx) => {
    try {
      const settings = await AppRuntime.runPromise(
        Effect.flatMap(SettingsService, (s) => s.getSettings()),
      );
      return settings;
    } catch (e) {
      return handleAppError(e, ctx);
    }
  })
  .put(
    "/",
    async (ctx) => {
      try {
        const updated = await AppRuntime.runPromise(
          Effect.gen(function* () {
            const settingsSvc = yield* SettingsService;
            const scheduler = yield* PollScheduler;
            const result = yield* settingsSvc.updateSettings(ctx.body);
            if (ctx.body.autoFetchInterval !== undefined) {
              yield* scheduler.restart(ctx.body.autoFetchInterval);
            }
            return result;
          }),
        );
        return updated;
      } catch (e) {
        return handleAppError(e, ctx);
      }
    },
    {
      body: t.Partial(
        t.Object({
          aiProvider: t.String(),
          aiModel: t.String(),
          aiSuggestionsModel: t.String(),
          aiThinkingEffort: t.Union([
            t.Literal("ultrathink"),
            t.Literal("max"),
            t.Literal("extra-high"),
            t.Literal("high"),
            t.Literal("medium"),
            t.Literal("low"),
          ]),
          aiContextWindow: t.Union([t.Literal("200k"), t.Literal("1m")]),
          aiMaxTurns: t.Number({ minimum: 10, maximum: 500 }),
          aiAgent: t.Union([t.Literal("opencode"), t.Literal("claude")]),
          theme: t.Union([t.Literal("system"), t.Literal("light"), t.Literal("dark")]),
          diffViewMode: t.Union([t.Literal("unified"), t.Literal("split")]),
          autoFetchInterval: t.Number(),
          githubHost: t.String({ minLength: 1 }),
          recap: t.Partial(
            t.Object({
              enabled: t.Boolean(),
              dailyEnabled: t.Boolean(),
              weeklyEnabled: t.Boolean(),
              agent: t.Union([t.Literal("auto"), t.Literal("opencode"), t.Literal("claude")]),
            }),
          ),
          cache: t.Partial(
            t.Object({
              enabled: t.Boolean(),
              bucket: t.String(),
              uploadsEnabled: t.Boolean(),
              downloadsEnabled: t.Boolean(),
              signing: t.Partial(
                t.Object({
                  mode: t.Union([t.Literal("off"), t.Literal("permissive"), t.Literal("strict")]),
                  keyPath: t.String(),
                  trustedSignerHosts: t.Array(t.String()),
                }),
              ),
            }),
          ),
          updateChannel: updateChannelSchema.optional,
        }),
      ),
    },
  )
  .get("/cache/status", async (ctx) => {
    try {
      return await AppRuntime.runPromise(
        Effect.gen(function* () {
          const blob = yield* BlobStore;
          return yield* blob.status();
        }),
      );
    } catch (e) {
      return handleAppError(e, ctx);
    }
  })
  .post("/cache/signing/test", async (ctx) => {
    try {
      const probe = "revv-signing-test";
      const result = await AppRuntime.runPromise(
        Effect.gen(function* () {
          const signerSvc = yield* SshSigner;
          const signed = yield* signerSvc.sign(probe);
          yield* signerSvc.verify(probe, signed.signature, signed.signerHost, signed.signerLogin);
          return {
            ok: true as const,
            signerLogin: signed.signerLogin,
            signerHost: signed.signerHost,
            signatureNamespace: signed.signatureNamespace,
          };
        }).pipe(
          Effect.catchAll((e) =>
            Effect.succeed({
              ok: false as const,
              error: (e as { message?: string }).message ?? String(e),
            }),
          ),
        ),
      );
      return result;
    } catch (e) {
      return handleAppError(e, ctx);
    }
  })
  .get("/cache/adc-status", async (ctx) => {
    try {
      return await AppRuntime.runPromise(
        Effect.sync(() => {
          const { existsSync } = require("node:fs");
          const { homedir } = require("node:os");
          const { join } = require("node:path");

          // 1. Probe for gcloud binary (needed for validation)
          let gcloudPath: string | null = null;
          try {
            gcloudPath = Bun.which("gcloud");
          } catch {
            // Bun.which throws if not found
          }
          if (!gcloudPath) {
            const home = homedir();
            const candidates =
              process.platform === "win32"
                ? [
                    join(
                      home,
                      "AppData",
                      "Local",
                      "Google",
                      "Cloud SDK",
                      "google-cloud-sdk",
                      "bin",
                      "gcloud.cmd",
                    ),
                    "C:\\Program Files (x86)\\Google\\Cloud SDK\\google-cloud-sdk\\bin\\gcloud.cmd",
                    "C:\\Program Files\\Google\\Cloud SDK\\google-cloud-sdk\\bin\\gcloud.cmd",
                  ]
                : [
                    join(home, "google-cloud-sdk", "bin", "gcloud"),
                    "/opt/homebrew/bin/gcloud",
                    "/usr/local/bin/gcloud",
                    "/usr/bin/gcloud",
                  ];
            for (const c of candidates) {
              if (existsSync(c)) {
                gcloudPath = c;
                break;
              }
            }
          }

          // 2. Check for explicit env override (service-account keys or
          // manually-set paths). We don't validate these with gcloud because
          // service-account JSON keys don't work with `application-default
          // print-access-token`; we trust the explicit configuration.
          const envPath = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
          if (envPath && envPath.length > 0 && existsSync(envPath)) {
            return {
              available: true,
              source: "env",
              gcloudFound: gcloudPath !== null,
              gcloudPath: gcloudPath ?? null,
              adcPath: envPath,
            };
          }

          // 3. Platform-dependent default ADC path
          const home = homedir();
          let adcPath: string;
          if (process.platform === "win32") {
            const appData = process.env.APPDATA;
            adcPath = appData
              ? join(appData, "gcloud", "application_default_credentials.json")
              : "";
          } else {
            adcPath = join(home, ".config", "gcloud", "application_default_credentials.json");
          }

          const adcExists = adcPath.length > 0 && existsSync(adcPath);

          // Validate by asking gcloud to print an access token.
          // File-existence alone isn't enough: `gcloud auth revoke` doesn't
          // delete application_default_credentials.json, so the stale file
          // would still report "ready".
          function isAdcValid(): boolean {
            if (!gcloudPath) return adcExists; // can't validate, fall back to file check
            try {
              const { spawnSync } = require("node:child_process");
              const result = spawnSync(
                gcloudPath,
                ["auth", "application-default", "print-access-token"],
                { timeout: 5000, stdio: ["ignore", "pipe", "pipe"] },
              );
              return result.status === 0;
            } catch {
              return false;
            }
          }

          return {
            available: adcExists && isAdcValid(),
            source: adcExists ? "default" : null,
            gcloudFound: gcloudPath !== null,
            gcloudPath: gcloudPath ?? null,
            adcPath: adcPath.length > 0 ? adcPath : null,
          };
        }),
      );
    } catch (e) {
      return handleAppError(e, ctx);
    }
  })
  .post("/cache/adc-login", async (ctx) => {
    try {
      return await AppRuntime.runPromise(
        Effect.sync(() => {
          let gcloudPath: string | null = null;
          try {
            gcloudPath = Bun.which("gcloud");
          } catch {
            // fall through
          }
          if (!gcloudPath) {
            const { homedir } = require("node:os");
            const { join } = require("node:path");
            const { existsSync } = require("node:fs");
            const home = homedir();
            const candidates =
              process.platform === "win32"
                ? [
                    join(
                      home,
                      "AppData",
                      "Local",
                      "Google",
                      "Cloud SDK",
                      "google-cloud-sdk",
                      "bin",
                      "gcloud.cmd",
                    ),
                    "C:\\Program Files (x86)\\Google\\Cloud SDK\\google-cloud-sdk\\bin\\gcloud.cmd",
                    "C:\\Program Files\\Google\\Cloud SDK\\google-cloud-sdk\\bin\\gcloud.cmd",
                  ]
                : [
                    join(home, "google-cloud-sdk", "bin", "gcloud"),
                    "/opt/homebrew/bin/gcloud",
                    "/usr/local/bin/gcloud",
                    "/usr/bin/gcloud",
                  ];
            for (const c of candidates) {
              if (existsSync(c)) {
                gcloudPath = c;
                break;
              }
            }
          }

          if (!gcloudPath) {
            return {
              started: false,
              error: "gcloud CLI not found. Install the Google Cloud SDK first.",
            };
          }

          const proc = Bun.spawn([gcloudPath, "auth", "application-default", "login"], {
            detached: true,
            stdio: ["ignore", "ignore", "ignore"],
          });

          // Unref so the server doesn't wait for the child to exit
          if (typeof proc.unref === "function") {
            proc.unref();
          }

          return { started: true, pid: proc.pid };
        }),
      );
    } catch (e) {
      return handleAppError(e, ctx);
    }
  })
  .get("/ai-status", async (ctx) => {
    try {
      return await AppRuntime.runPromise(
        Effect.gen(function* () {
          const ai = yield* AiService;
          const settingsSvc = yield* SettingsService;
          const configured = yield* ai.isConfigured();
          const settings = yield* settingsSvc.getSettings();
          return { configured, model: settings.aiModel, aiAgent: settings.aiAgent };
        }),
      );
    } catch (e) {
      return handleAppError(e, ctx);
    }
  })
  .get(
    "/models",
    async (ctx) => {
      try {
        const agentParam = ctx.query?.agent;
        let agent: "opencode" | "claude";
        if (agentParam === "opencode" || agentParam === "claude") {
          agent = agentParam;
        } else {
          const settings = await AppRuntime.runPromise(
            Effect.flatMap(SettingsService, (s) => s.getSettings()),
          );
          agent = resolveAgent(settings);
        }
        const models = await listCliModels(agent);
        return { models, agent };
      } catch (e) {
        return handleAppError(e, ctx);
      }
    },
    {
      query: t.Optional(
        t.Object({
          agent: t.Optional(t.Union([t.Literal("opencode"), t.Literal("claude")])),
        }),
      ),
    },
  );
