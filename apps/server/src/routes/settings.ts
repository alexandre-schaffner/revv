import { Effect } from "effect";
import { Elysia, t } from "elysia";
import { listCliModels } from "../ai/providers/cli-agent";
import { AppRuntime } from "../runtime";
import { AiService, resolveAgent } from "../services/Ai";
import { PollScheduler } from "../services/PollScheduler";
import { SettingsService } from "../services/Settings";
import { handleAppError } from "./middleware";

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
          aiThinkingEffort: t.Union([
            t.Literal("ultrathink"),
            t.Literal("max"),
            t.Literal("extra-high"),
            t.Literal("high"),
            t.Literal("medium"),
            t.Literal("low"),
          ]),
          aiContextWindow: t.Union([t.Literal("200k"), t.Literal("1m")]),
          aiAgent: t.Union([t.Literal("opencode"), t.Literal("claude")]),
          theme: t.String(),
          diffViewMode: t.String(),
          autoFetchInterval: t.Number(),
        }),
      ),
    },
  )
  .get("/ai-status", async (ctx) => {
    try {
      return await AppRuntime.runPromise(
        Effect.gen(function* () {
          const ai = yield* AiService;
          const settingsSvc = yield* SettingsService;
          const configured = yield* ai.isConfigured();
          const settings = yield* settingsSvc.getSettings();
          return {
            configured,
            model: settings.aiModel,
            aiAgent: settings.aiAgent,
          };
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
          agent: t.Optional(
            t.Union([t.Literal("opencode"), t.Literal("claude")]),
          ),
        }),
      ),
    },
  );
