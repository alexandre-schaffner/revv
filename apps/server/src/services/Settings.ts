import {
  type AcpAgentId,
  applySettingsUpdate,
  DEFAULT_USER_SETTINGS,
  isAcpAgentId,
  normalizeSettings,
  type SettingsUpdate,
  type UserSettings,
} from "@revv/shared";
import { eq } from "drizzle-orm";
import { Context, Effect, Layer, Stream, SubscriptionRef } from "effect";
import { serverEnv } from "../config";
import type { Db } from "../db/index";
import { userSettings } from "../db/schema/user-settings";
import { DbError } from "../domain/errors";
import { DbService } from "./Db";

// One row, id = 'default'. Every field is normalized on the way in and out, so
// a stale or hand-edited row still yields valid settings.
const ROW_ID = "default";

function parseJsonList(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

function fromRow(row: typeof userSettings.$inferSelect): UserSettings {
  return normalizeSettings({
    aiAgent: row.aiAgent,
    aiModel: row.aiModel,
    aiThinkingEffort: row.aiThinkingEffort,
    aiSuggestionsModel: row.aiSuggestionsModel,
    aiMaxTurns: row.aiMaxTurns,
    diffViewMode: row.diffViewMode,
    autoFetchInterval: row.autoFetchInterval,
    recap: {
      enabled: row.recapEnabled,
      dailyEnabled: row.recapDailyEnabled,
      weeklyEnabled: row.recapWeeklyEnabled,
      agent: row.recapAgent,
    },
    githubHost: row.githubHost,
    githubClientId: row.githubClientId,
    cache: {
      enabled: row.cacheEnabled,
      bucket: row.cacheBucket,
      uploadsEnabled: row.cacheUploadsEnabled,
      downloadsEnabled: row.cacheDownloadsEnabled,
      signing: {
        mode: row.cacheSigningMode,
        keyPath: row.cacheSigningKeyPath,
        trustedSignerHosts: parseJsonList(row.cacheTrustedSignerHosts),
      },
    },
    jev: { enabled: row.jevEnabled },
    updateChannel: row.updateChannel,
    baseConflictStrategy: row.baseConflictStrategy,
  });
}

function toRow(s: UserSettings): typeof userSettings.$inferInsert {
  return {
    id: ROW_ID,
    aiAgent: s.aiAgent,
    aiModel: s.aiModel,
    aiThinkingEffort: s.aiThinkingEffort,
    aiSuggestionsModel: s.aiSuggestionsModel,
    aiMaxTurns: s.aiMaxTurns,
    diffViewMode: s.diffViewMode,
    autoFetchInterval: s.autoFetchInterval,
    recapEnabled: s.recap.enabled,
    recapDailyEnabled: s.recap.dailyEnabled,
    recapWeeklyEnabled: s.recap.weeklyEnabled,
    recapAgent: s.recap.agent,
    githubHost: s.githubHost,
    githubClientId: s.githubClientId,
    cacheEnabled: s.cache.enabled,
    cacheBucket: s.cache.bucket,
    cacheUploadsEnabled: s.cache.uploadsEnabled,
    cacheDownloadsEnabled: s.cache.downloadsEnabled,
    cacheSigningMode: s.cache.signing.mode,
    cacheSigningKeyPath: s.cache.signing.keyPath,
    cacheTrustedSignerHosts: JSON.stringify(s.cache.signing.trustedSignerHosts),
    jevEnabled: s.jev.enabled,
    updateChannel: s.updateChannel,
    baseConflictStrategy: s.baseConflictStrategy,
    updatedAt: new Date(),
  };
}

/** `hasApiKey` lives in the keyring, never in the row or this service's state. */
function withoutDerived(s: UserSettings): UserSettings {
  return s.jev.hasApiKey ? { ...s, jev: { ...s.jev, hasApiKey: false } } : s;
}

async function writeRow(db: Db, s: UserSettings): Promise<void> {
  const row = toRow(s);
  await db
    .insert(userSettings)
    .values(row)
    .onConflictDoUpdate({ target: userSettings.id, set: row });
}

/**
 * Load the row, or seed it on first boot. Installs from before the DB kept
 * settings in `~/.revv/settings.json` (legacy-upgrade: settingsJson); that file
 * is imported once, then removed.
 */
async function loadOrSeed(db: Db, settingsPath: string): Promise<UserSettings> {
  const [row] = await db.select().from(userSettings).where(eq(userSettings.id, ROW_ID)).limit(1);
  if (row) return fromRow(row);

  const { existsSync, readFileSync, unlinkSync } = await import("node:fs");

  let settings = DEFAULT_USER_SETTINGS;
  if (existsSync(settingsPath)) {
    try {
      const raw: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
      // The legacy file kept the chat agent in its own `chatAgent` field.
      const legacy =
        typeof raw === "object" && raw !== null && "chatAgent" in raw
          ? { ...raw, aiAgent: raw.chatAgent }
          : raw;
      settings = withoutDerived(normalizeSettings(legacy));
    } catch {
      settings = DEFAULT_USER_SETTINGS;
    }
  }

  await writeRow(db, settings);
  try {
    unlinkSync(settingsPath);
  } catch {
    // Already gone.
  }
  return settings;
}

/** `REVV_ACP_AGENT`, a testing knob, overrides the persisted agent when it names a registry agent. */
function withAgentOverride(agent: AcpAgentId): AcpAgentId {
  const override = serverEnv.acpAgent.trim();
  return override && isAcpAgentId(override) ? override : agent;
}

export class SettingsService extends Context.Service<
  SettingsService,
  {
    /** The in-memory snapshot of the row; `jev.hasApiKey` is always `false` here. */
    getSettings: () => Effect.Effect<UserSettings>;
    /** Persists the normalized result of the patch (with the agent-switch cascade), then publishes it. */
    updateSettings: (patch: SettingsUpdate) => Effect.Effect<UserSettings, DbError>;
    /** Every committed change after subscription. React to settings here, not at the write site. */
    settingsChanges: () => Stream.Stream<UserSettings>;
    /** The GitHub host for flows with no repository in hand: the settings host, else `GITHUB_HOST`. */
    githubHost: () => Effect.Effect<string>;
    /**
     * The `select`ed value whenever a committed change alters it (compared with
     * `Equal.equals`, so select a primitive or a key, not a fresh object).
     */
    watch: <A>(select: (s: UserSettings) => A) => Stream.Stream<A>;
    /** The agent that runs chat, walkthroughs and suggestions. */
    resolveAgent: () => Effect.Effect<AcpAgentId>;
    resolveRecapAgent: () => Effect.Effect<AcpAgentId>;
  }
>()("SettingsService") {}

/** `legacySettingsPath` is the pre-DB JSON file to import on first boot (a test points it at a temp dir). */
export const settingsServiceLayer = (legacySettingsPath: string) =>
  Layer.effect(
    SettingsService,
    Effect.gen(function* () {
      const { db } = yield* DbService;

      const initial = yield* Effect.tryPromise({
        try: () => loadOrSeed(db, legacySettingsPath),
        catch: (cause) => new DbError({ message: "Failed to load settings", cause }),
      });
      const settingsRef = yield* SubscriptionRef.make(initial);

      return {
        getSettings: () => SubscriptionRef.get(settingsRef),

        updateSettings: (patch) =>
          Effect.gen(function* () {
            const current = yield* SubscriptionRef.get(settingsRef);
            const next = withoutDerived(applySettingsUpdate(current, patch));
            yield* Effect.tryPromise({
              try: () => writeRow(db, next),
              catch: (cause) => new DbError({ message: "Failed to save settings", cause }),
            });
            yield* SubscriptionRef.set(settingsRef, next);
            return next;
          }),

        settingsChanges: () => SubscriptionRef.changes(settingsRef).pipe(Stream.drop(1)),

        githubHost: () =>
          Effect.map(
            SubscriptionRef.get(settingsRef),
            (s) => s.githubHost.trim() || serverEnv.githubHost,
          ),

        // `changes` starts with the current value; it seeds the comparison, then is dropped.
        watch: (select) =>
          SubscriptionRef.changes(settingsRef).pipe(
            Stream.map(select),
            Stream.changes,
            Stream.drop(1),
          ),

        resolveAgent: () =>
          Effect.map(SubscriptionRef.get(settingsRef), (s) => withAgentOverride(s.aiAgent)),

        resolveRecapAgent: () =>
          Effect.map(SubscriptionRef.get(settingsRef), (s) =>
            withAgentOverride(s.recap.agent === "auto" ? s.aiAgent : s.recap.agent),
          ),
      };
    }),
  );

export const SettingsServiceLive = settingsServiceLayer(serverEnv.legacySettingsPath);
