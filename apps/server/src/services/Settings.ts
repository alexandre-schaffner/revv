import type {
  AiAgent,
  ContextWindow,
  DiffViewMode,
  RecapAgentChoice,
  ThemePreference,
  ThinkingEffort,
  UpdateChannel,
  UserSettings,
} from "@revv/shared";
import { AUTO_FETCH_DEFAULT_INTERVAL, DEFAULT_UPDATE_CHANNEL, UPDATE_CHANNELS } from "@revv/shared";
import { eq } from "drizzle-orm";
import { Context, Effect, Layer, Stream, SubscriptionRef } from "effect";
import type { Db } from "../db/index";
import { userSettings } from "../db/schema/user-settings";
import { ValidationError } from "../domain/errors";
import { logError } from "../logger";
import { DbService } from "./Db";

// ── Storage ───────────────────────────────────────────────────────────────────
// Settings live in the `user_settings` SQLite table (single row, id='default').
// On first boot after this migration, existing `~/.revv/settings.json` is read
// and upserted into the DB, then the JSON file is deleted.

const DEFAULT_SETTINGS: UserSettings = {
  id: "default",
  aiProvider: "anthropic",
  aiModel: "opencode/big-pickle",
  aiThinkingEffort: "medium",
  aiAgent: "opencode",
  aiContextWindow: "200k",
  aiSuggestionsModel: "opencode/big-pickle",
  aiMaxTurns: 60,
  theme: "dark",
  diffViewMode: "unified",
  autoFetchInterval: AUTO_FETCH_DEFAULT_INTERVAL,
  githubHost: "github.com",
  recap: {
    enabled: true,
    dailyEnabled: true,
    weeklyEnabled: true,
    agent: "auto",
  },
  cache: {
    enabled: false,
    bucket: "",
    uploadsEnabled: true,
    downloadsEnabled: true,
    signing: {
      mode: "strict" as const,
      keyPath: "",
      trustedSignerHosts: [],
    },
  },
  updateChannel: DEFAULT_UPDATE_CHANNEL,
};

const VALID_UPDATE_CHANNELS: ReadonlySet<UpdateChannel> = new Set(UPDATE_CHANNELS);
function coerceUpdateChannel(value: unknown): UpdateChannel {
  return typeof value === "string" && VALID_UPDATE_CHANNELS.has(value as UpdateChannel)
    ? (value as UpdateChannel)
    : DEFAULT_SETTINGS.updateChannel;
}

const VALID_RECAP_AGENTS: ReadonlySet<RecapAgentChoice> = new Set([
  "auto",
  "opencode",
  "claude",
  "codex",
]);

export type AgentId = AiAgent;

const MIN_MAX_TURNS = 10;
const MAX_MAX_TURNS = 500;

function coerceMaxTurns(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_SETTINGS.aiMaxTurns;
  }
  const int = Math.floor(value);
  if (int < MIN_MAX_TURNS) return MIN_MAX_TURNS;
  if (int > MAX_MAX_TURNS) return MAX_MAX_TURNS;
  return int;
}

const VALID_THEMES: ReadonlySet<ThemePreference> = new Set(["system", "light", "dark"]);
function coerceTheme(value: string): ThemePreference {
  return VALID_THEMES.has(value as ThemePreference)
    ? (value as ThemePreference)
    : DEFAULT_SETTINGS.theme;
}

const VALID_DIFF_MODES: ReadonlySet<DiffViewMode> = new Set(["unified", "split"]);
function coerceDiffViewMode(value: string): DiffViewMode {
  return VALID_DIFF_MODES.has(value as DiffViewMode)
    ? (value as DiffViewMode)
    : DEFAULT_SETTINGS.diffViewMode;
}

/** Coerce an arbitrary JSON value into a fully-shaped `UserSettings`. */
function normalize(raw: unknown): UserSettings {
  if (typeof raw !== "object" || raw === null) return { ...DEFAULT_SETTINGS };
  const r = raw as Record<string, unknown>;
  return {
    id: typeof r.id === "string" ? (r.id as string) : DEFAULT_SETTINGS.id,
    aiProvider:
      typeof r.aiProvider === "string" ? (r.aiProvider as string) : DEFAULT_SETTINGS.aiProvider,
    aiModel: typeof r.aiModel === "string" ? (r.aiModel as string) : DEFAULT_SETTINGS.aiModel,
    aiThinkingEffort:
      typeof r.aiThinkingEffort === "string"
        ? (r.aiThinkingEffort as ThinkingEffort)
        : DEFAULT_SETTINGS.aiThinkingEffort,
    aiAgent:
      r.aiAgent === "opencode" || r.aiAgent === "claude" || r.aiAgent === "codex"
        ? r.aiAgent
        : DEFAULT_SETTINGS.aiAgent,
    aiContextWindow:
      typeof r.aiContextWindow === "string"
        ? (r.aiContextWindow as ContextWindow)
        : DEFAULT_SETTINGS.aiContextWindow,
    aiSuggestionsModel:
      typeof r.aiSuggestionsModel === "string"
        ? (r.aiSuggestionsModel as string)
        : DEFAULT_SETTINGS.aiSuggestionsModel,
    aiMaxTurns: coerceMaxTurns(r.aiMaxTurns),
    theme: typeof r.theme === "string" ? coerceTheme(r.theme) : DEFAULT_SETTINGS.theme,
    diffViewMode:
      typeof r.diffViewMode === "string"
        ? coerceDiffViewMode(r.diffViewMode)
        : DEFAULT_SETTINGS.diffViewMode,
    autoFetchInterval:
      typeof r.autoFetchInterval === "number"
        ? (r.autoFetchInterval as number)
        : DEFAULT_SETTINGS.autoFetchInterval,
    githubHost:
      typeof r.githubHost === "string" && (r.githubHost as string).length > 0
        ? (r.githubHost as string)
        : DEFAULT_SETTINGS.githubHost,
    recap: coerceRecap(r.recap),
    cache: coerceCache(r.cache),
    updateChannel: coerceUpdateChannel(r.updateChannel),
  };
}

const VALID_SIGNING_MODES = new Set(["off", "permissive", "strict"]);

function coerceCacheSigning(value: unknown): UserSettings["cache"]["signing"] {
  if (value === null || typeof value !== "object") {
    return { ...DEFAULT_SETTINGS.cache.signing };
  }
  const r = value as Record<string, unknown>;
  const mode =
    typeof r.mode === "string" && VALID_SIGNING_MODES.has(r.mode)
      ? (r.mode as "off" | "permissive" | "strict")
      : DEFAULT_SETTINGS.cache.signing.mode;
  const keyPath =
    typeof r.keyPath === "string" ? r.keyPath : DEFAULT_SETTINGS.cache.signing.keyPath;
  let trustedSignerHosts = DEFAULT_SETTINGS.cache.signing.trustedSignerHosts;
  if (Array.isArray(r.trustedSignerHosts)) {
    trustedSignerHosts = r.trustedSignerHosts.filter((h): h is string => typeof h === "string");
  }
  return { mode, keyPath, trustedSignerHosts };
}

function coerceCache(value: unknown): UserSettings["cache"] {
  if (value === null || typeof value !== "object") return { ...DEFAULT_SETTINGS.cache };
  const r = value as Record<string, unknown>;
  return {
    enabled: r.enabled === true,
    bucket: typeof r.bucket === "string" ? r.bucket : DEFAULT_SETTINGS.cache.bucket,
    uploadsEnabled: r.uploadsEnabled === false ? false : DEFAULT_SETTINGS.cache.uploadsEnabled,
    downloadsEnabled:
      r.downloadsEnabled === false ? false : DEFAULT_SETTINGS.cache.downloadsEnabled,
    signing: coerceCacheSigning(r.signing),
  };
}

function coerceRecap(value: unknown): UserSettings["recap"] {
  if (value === null || typeof value !== "object") return { ...DEFAULT_SETTINGS.recap };
  const r = value as Record<string, unknown>;
  const agent =
    typeof r.agent === "string" && VALID_RECAP_AGENTS.has(r.agent as RecapAgentChoice)
      ? (r.agent as RecapAgentChoice)
      : DEFAULT_SETTINGS.recap.agent;
  return {
    enabled: r.enabled === false ? false : DEFAULT_SETTINGS.recap.enabled,
    dailyEnabled: r.dailyEnabled === false ? false : DEFAULT_SETTINGS.recap.dailyEnabled,
    weeklyEnabled: r.weeklyEnabled === false ? false : DEFAULT_SETTINGS.recap.weeklyEnabled,
    agent,
  };
}

function resolveAgentFromSettings(settings: Pick<UserSettings, "aiAgent">): AgentId {
  const agent = settings.aiAgent ?? DEFAULT_SETTINGS.aiAgent;
  if (agent === "opencode" || agent === "claude" || agent === "codex") return agent;
  throw new ValidationError({
    message: `Unknown aiAgent '${agent}' — expected "opencode", "claude", or "codex"`,
    field: "aiAgent",
  });
}

function resolveRecapAgentFromSettings(settings: Pick<UserSettings, "aiAgent" | "recap">): AgentId {
  const choice = settings.recap?.agent ?? DEFAULT_SETTINGS.recap.agent;
  if (choice === "opencode" || choice === "claude" || choice === "codex") return choice;
  if (choice === "auto") return resolveAgentFromSettings(settings);
  throw new ValidationError({
    message: `Unknown recap.agent '${choice}' — expected "auto", "opencode", "claude", or "codex"`,
    field: "recap.agent",
  });
}

// ── DB ↔ UserSettings mapping ────────────────────────────────────────────────

function toSettings(row: typeof userSettings.$inferSelect): UserSettings {
  return {
    id: row.id,
    aiProvider: row.aiProvider,
    aiModel: row.aiModel,
    aiThinkingEffort: row.aiThinkingEffort as ThinkingEffort,
    aiAgent: row.aiAgent as AiAgent,
    aiContextWindow: row.aiContextWindow as ContextWindow,
    aiSuggestionsModel: row.aiSuggestionsModel,
    aiMaxTurns: row.aiMaxTurns,
    theme: row.theme as ThemePreference,
    diffViewMode: row.diffViewMode as DiffViewMode,
    autoFetchInterval: row.autoFetchInterval,
    githubHost: row.githubHost,
    recap: {
      enabled: row.recapEnabled,
      dailyEnabled: row.recapDailyEnabled,
      weeklyEnabled: row.recapWeeklyEnabled,
      agent: row.recapAgent as RecapAgentChoice,
    },
    cache: {
      enabled: row.cacheEnabled,
      bucket: row.cacheBucket,
      uploadsEnabled: row.cacheUploadsEnabled,
      downloadsEnabled: row.cacheDownloadsEnabled,
      signing: coerceCacheSigning(
        (() => {
          try {
            return {
              mode: row.cacheSigningMode,
              keyPath: row.cacheSigningKeyPath,
              trustedSignerHosts: JSON.parse(row.cacheTrustedSignerHosts ?? "[]"),
            };
          } catch {
            return null;
          }
        })(),
      ),
    },
    updateChannel: coerceUpdateChannel(row.updateChannel),
  };
}

function toInsert(s: UserSettings): typeof userSettings.$inferInsert {
  return {
    id: s.id,
    aiProvider: s.aiProvider,
    aiModel: s.aiModel,
    aiThinkingEffort: s.aiThinkingEffort,
    aiAgent: s.aiAgent,
    aiContextWindow: s.aiContextWindow,
    aiSuggestionsModel: s.aiSuggestionsModel,
    aiMaxTurns: s.aiMaxTurns,
    theme: s.theme,
    diffViewMode: s.diffViewMode,
    autoFetchInterval: s.autoFetchInterval,
    githubHost: s.githubHost,
    recapEnabled: s.recap.enabled,
    recapDailyEnabled: s.recap.dailyEnabled,
    recapWeeklyEnabled: s.recap.weeklyEnabled,
    recapAgent: s.recap.agent,
    cacheEnabled: s.cache.enabled,
    cacheBucket: s.cache.bucket,
    cacheCredentialsJson: "",
    cacheCredentialsPath: "",
    cacheUploadsEnabled: s.cache.uploadsEnabled,
    cacheDownloadsEnabled: s.cache.downloadsEnabled,
    updateChannel: s.updateChannel,
    cacheSigningMode: s.cache.signing.mode,
    cacheSigningKeyPath: s.cache.signing.keyPath,
    cacheTrustedSignerHosts: JSON.stringify(s.cache.signing.trustedSignerHosts),
    updatedAt: new Date(),
  };
}

// ── JSON file migration (one-time) ───────────────────────────────────────────

async function migrateJsonToDb(db: Db): Promise<UserSettings> {
  const { existsSync, readFileSync, unlinkSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { homedir } = await import("node:os");

  const settingsPath = process.env.REVV_SETTINGS_PATH ?? join(homedir(), ".revv", "settings.json");

  const [row] = await db.select().from(userSettings).where(eq(userSettings.id, "default")).limit(1);

  if (row) {
    return toSettings(row);
  }

  // No DB row — try reading from JSON file for backward compat
  let settings: UserSettings;
  if (existsSync(settingsPath)) {
    try {
      const raw = readFileSync(settingsPath, "utf8");
      settings = normalize(JSON.parse(raw));
    } catch {
      settings = { ...DEFAULT_SETTINGS };
    }
  } else {
    settings = { ...DEFAULT_SETTINGS };
  }

  // Upsert into DB
  await db
    .insert(userSettings)
    .values(toInsert(settings))
    .onConflictDoUpdate({
      target: userSettings.id,
      set: toInsert(settings),
    });

  // Delete JSON file after successful migration
  try {
    unlinkSync(settingsPath);
  } catch {
    // Non-fatal — JSON file may already be gone
  }

  return settings;
}

// ── Service definition ────────────────────────────────────────────────────────

/**
 * Shape accepted by `updateSettings`. Top-level fields are individually
 * optional (standard `Partial`), but `recap` and `cache` are recursively
 * partial so callers can patch a single nested field (e.g.
 * `{ recap: { agent: 'opencode' } }`) without spreading the whole
 * sub-object. {@link Settings.ts}'s `updateSettings` deep-merges them
 * against the current value to honour this contract.
 */
export type SettingsUpdate = Partial<Omit<UserSettings, "id" | "recap" | "cache">> & {
  recap?: Partial<UserSettings["recap"]>;
  cache?: Partial<Omit<UserSettings["cache"], "signing">> & {
    signing?: Partial<UserSettings["cache"]["signing"]>;
  };
};

export class SettingsService extends Context.Tag("SettingsService")<
  SettingsService,
  {
    getSettings: () => Effect.Effect<UserSettings, ValidationError>;
    updateSettings: (partial: SettingsUpdate) => Effect.Effect<UserSettings, ValidationError>;
    settingsChanges: () => Stream.Stream<UserSettings>;
    resolveAgent: () => Effect.Effect<AgentId, ValidationError>;
    resolveAgentOrDefault: () => Effect.Effect<AgentId>;
    resolveRecapAgent: () => Effect.Effect<AgentId, ValidationError>;
  }
>() {}

export const SettingsServiceLive = Layer.effect(
  SettingsService,
  Effect.gen(function* () {
    const { db } = yield* DbService;

    // Load settings from DB (migrating from JSON if needed)
    const initial = yield* Effect.tryPromise({
      try: () => migrateJsonToDb(db),
      catch: (e) =>
        new ValidationError({
          message: e instanceof Error ? e.message : String(e),
        }),
    });
    const settingsRef = yield* SubscriptionRef.make(initial);

    return {
      getSettings: () =>
        settingsRef.get.pipe(Effect.mapError((e) => new ValidationError({ message: String(e) }))),

      updateSettings: (partial) =>
        Effect.gen(function* () {
          const current = yield* settingsRef.get;
          const mergedRecap =
            partial.recap !== undefined ? { ...current.recap, ...partial.recap } : current.recap;
          const mergedCache =
            partial.cache !== undefined
              ? {
                  ...current.cache,
                  ...partial.cache,
                  signing:
                    partial.cache.signing !== undefined
                      ? { ...current.cache.signing, ...partial.cache.signing }
                      : current.cache.signing,
                }
              : current.cache;
          const merged: UserSettings = {
            ...current,
            ...partial,
            recap: mergedRecap,
            cache: mergedCache,
            id: "default",
          };
          const next: UserSettings = {
            ...merged,
            aiMaxTurns: coerceMaxTurns(merged.aiMaxTurns),
            updateChannel: coerceUpdateChannel(merged.updateChannel),
          };

          yield* Effect.tryPromise({
            try: () =>
              db
                .insert(userSettings)
                .values(toInsert(next))
                .onConflictDoUpdate({
                  target: userSettings.id,
                  set: toInsert(next),
                }),
            catch: (e) =>
              new ValidationError({
                message: e instanceof Error ? e.message : String(e),
              }),
          });

          yield* SubscriptionRef.set(settingsRef, next);
          return next;
        }),

      settingsChanges: () => settingsRef.changes.pipe(Stream.drop(1)),

      resolveAgent: () =>
        settingsRef.get.pipe(
          Effect.mapError((e) => new ValidationError({ message: String(e) })),
          Effect.map(resolveAgentFromSettings),
        ),

      resolveAgentOrDefault: () =>
        settingsRef.get.pipe(
          Effect.mapError((e) => new ValidationError({ message: String(e) })),
          Effect.map(resolveAgentFromSettings),
          Effect.tapError((e) =>
            Effect.sync(() => {
              logError(
                "settings",
                "resolveAgentOrDefault failed, defaulting to opencode:",
                String(e),
              );
            }),
          ),
          Effect.orElseSucceed(() => "opencode" as const),
        ),

      resolveRecapAgent: () =>
        settingsRef.get.pipe(
          Effect.mapError((e) => new ValidationError({ message: String(e) })),
          Effect.map(resolveRecapAgentFromSettings),
        ),
    };
  }),
);
