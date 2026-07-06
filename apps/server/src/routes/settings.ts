import { ACP_AGENT_IDS, type AcpAgentId, getAgentCredentials, isAcpAgentId } from "@revv/shared";
import { Effect } from "effect";
import { Elysia, t } from "elysia";
import { isCommandOnPath, listCliModels, resolveCliBin } from "../ai/providers/cli-agent";
import { AppRuntime } from "../runtime";
import { AiService } from "../services/Ai";
import { BlobStore } from "../services/blob/BlobStore";
import { SshSigner } from "../services/cache-signing/index";
import { PollScheduler } from "../services/PollScheduler";
import { SettingsService } from "../services/Settings";
import { handleAppError } from "./middleware";
import { updateChannelSchema } from "./schemas";

// Registry-derived literal unions for request validation — adding an ACP agent
// to the shared registry extends these automatically.
const acpAgentLiterals = ACP_AGENT_IDS.map((id) => t.Literal(id));
const aiAgentSchema = t.Union(acpAgentLiterals);
const recapAgentSchema = t.Union([t.Literal("auto"), ...acpAgentLiterals]);

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
          aiAgent: aiAgentSchema,
          theme: t.Union([t.Literal("system"), t.Literal("light"), t.Literal("dark")]),
          diffViewMode: t.Union([t.Literal("unified"), t.Literal("split")]),
          autoFetchInterval: t.Number(),
          githubHost: t.String({ minLength: 1 }),
          githubClientId: t.String(),
          recap: t.Partial(
            t.Object({
              enabled: t.Boolean(),
              dailyEnabled: t.Boolean(),
              weeklyEnabled: t.Boolean(),
              agent: recapAgentSchema,
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
  // ── ACP agent credentials (agent-agnostic auth) ───────────────────────────
  // The packaged app runs the server as a LaunchAgent with a sparse env, so a
  // spawned ACP agent can't reach the OS keychain where its CLI stashes the
  // interactive login — chat 401s and generation dies with "ACP connection
  // closed". These endpoints capture (via a per-agent `setupCommand`) or accept
  // a pasted credential and store it for injection at spawn. Which env vars
  // apply is declared per agent in `ACP_AGENTS[].credentials`.
  .get("/agent-credentials", async (ctx) => {
    try {
      const connections = await AppRuntime.runPromise(
        Effect.flatMap(SettingsService, (s) => s.getAgentCredentialConnections()),
      );
      const items = ACP_AGENT_IDS.flatMap((agent) =>
        getAgentCredentials(agent).map((cred) => ({
          agent,
          envVar: cred.envVar,
          label: cred.label,
          hint: cred.hint,
          placeholder: cred.placeholder,
          hasSetup: (cred.setupCommand?.length ?? 0) > 0,
          connected: connections[agent]?.[cred.envVar] === true,
        })),
      );
      return { credentials: items };
    } catch (e) {
      return handleAppError(e, ctx);
    }
  })
  .post(
    "/agent-credentials/connect",
    async (ctx) => {
      try {
        const agent = ctx.body.agent as AcpAgentId;
        const cred = getAgentCredentials(agent).find((c) => c.envVar === ctx.body.envVar);
        if (!cred?.setupCommand || cred.setupCommand.length === 0 || !cred.tokenPattern) {
          return { connected: false, error: "This credential has no automated connect flow." };
        }
        const [command, ...rest] = cred.setupCommand;
        const bin =
          command === "claude" || command === "codex" || command === "opencode"
            ? resolveCliBin(command)
            : (command ?? "");
        if (!bin || !isCommandOnPath(command ?? "")) {
          return {
            connected: false,
            error: `\`${command}\` CLI not found. Install it and retry, or paste the ${cred.label} manually.`,
          };
        }

        // The setup command opens the browser for the OAuth flow, then prints the
        // credential to stdout. Capture it, bounded by a timeout so an abandoned
        // login doesn't wedge the request.
        const proc = Bun.spawn([bin, ...rest], {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        });
        const SETUP_TIMEOUT_MS = 180_000;
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          try {
            proc.kill();
          } catch {
            /* already gone */
          }
        }, SETUP_TIMEOUT_MS);

        let stdout = "";
        let stderr = "";
        try {
          [stdout, stderr] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
          ]);
          await proc.exited;
        } finally {
          clearTimeout(timer);
        }

        const token = `${stdout}\n${stderr}`.match(new RegExp(cred.tokenPattern))?.[0] ?? null;
        if (!token) {
          return {
            connected: false,
            error: timedOut
              ? `Timed out waiting for \`${cred.setupCommand.join(" ")}\`. Complete the login and retry.`
              : stderr.trim() ||
                `No credential returned by \`${cred.setupCommand.join(" ")}\`. Complete the login and retry.`,
          };
        }

        await AppRuntime.runPromise(
          Effect.flatMap(SettingsService, (s) => s.setAgentCredential(agent, cred.envVar, token)),
        );
        return { connected: true };
      } catch (e) {
        return handleAppError(e, ctx);
      }
    },
    { body: t.Object({ agent: aiAgentSchema, envVar: t.String() }) },
  )
  .post(
    "/agent-credentials",
    async (ctx) => {
      try {
        const value = ctx.body.value.trim();
        await AppRuntime.runPromise(
          Effect.flatMap(SettingsService, (s) =>
            s.setAgentCredential(ctx.body.agent as AcpAgentId, ctx.body.envVar, value || null),
          ),
        );
        return { connected: value.length > 0 };
      } catch (e) {
        return handleAppError(e, ctx);
      }
    },
    { body: t.Object({ agent: aiAgentSchema, envVar: t.String(), value: t.String() }) },
  )
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
        const agent: AcpAgentId =
          agentParam && isAcpAgentId(agentParam)
            ? agentParam
            : await AppRuntime.runPromise(Effect.flatMap(SettingsService, (s) => s.resolveAgent()));
        const models = await listCliModels(agent);
        return { models, agent };
      } catch (e) {
        return handleAppError(e, ctx);
      }
    },
    {
      query: t.Optional(
        t.Object({
          agent: t.Optional(aiAgentSchema),
        }),
      ),
    },
  );
