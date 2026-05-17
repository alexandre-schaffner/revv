import { existsSync, mkdirSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  AiAgent,
  ContextWindow,
  DiffViewMode,
  RecapAgentChoice,
  ThemePreference,
  ThinkingEffort,
  UserSettings,
} from "@revv/shared";
import { AUTO_FETCH_DEFAULT_INTERVAL } from "@revv/shared";
import { Context, Effect, Layer, Stream, SubscriptionRef } from "effect";
import { serverEnv } from "../config";
import { ValidationError } from "../domain/errors";

// ── Storage ───────────────────────────────────────────────────────────────────
// Settings live as JSON at `serverEnv.settingsPath` (`~/.revv/settings.json` by
// default). Single-user, no joins, no transactions — a flat file is plenty.
//
// Reads tolerate a missing or partially-corrupt file by falling back to the
// per-key default in {@link DEFAULT_SETTINGS} (deep-merged so unknown keys in
// the file are preserved across upgrades). Writes are atomic: write to a
// sibling `*.tmp` and rename, so a `kill -9` mid-write can never leave a
// truncated file the next reader chokes on.

const DEFAULT_SETTINGS: UserSettings = {
  id: "default",
  aiProvider: "anthropic",
  aiModel: "opencode/big-pickle",
  aiThinkingEffort: "medium",
  aiAgent: "opencode",
  aiContextWindow: "200k",
  // Same default as `aiModel` for the opencode-default install; if the
  // user is on Claude they should pick a cheaper model (Haiku) via the
  // settings UI — the AgentSelector also re-picks this when the user
  // switches agents.
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
};

const VALID_RECAP_AGENTS: ReadonlySet<RecapAgentChoice> = new Set(["auto", "opencode", "claude"]);

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
      r.aiAgent === "opencode" || r.aiAgent === "claude" ? r.aiAgent : DEFAULT_SETTINGS.aiAgent,
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

async function readSettingsFile(): Promise<UserSettings> {
  const path = serverEnv.settingsPath;
  if (!existsSync(path)) {
    // First run — write defaults so the file is observable for users
    // poking around `~/.revv` and any concurrent reader gets the same
    // canonical bytes we'd hand back from memory.
    await writeSettingsFile(DEFAULT_SETTINGS);
    return { ...DEFAULT_SETTINGS };
  }
  try {
    const raw = await Bun.file(path).text();
    const parsed = JSON.parse(raw);
    return normalize(parsed);
  } catch {
    // Corrupt JSON, encoding glitch, partial write from a crash that
    // somehow bypassed atomic-rename — restore defaults rather than
    // failing the whole settings endpoint. The next write will
    // overwrite the bad bytes.
    const fresh = { ...DEFAULT_SETTINGS };
    await writeSettingsFile(fresh).catch(() => undefined);
    return fresh;
  }
}

async function writeSettingsFile(settings: UserSettings): Promise<void> {
  const path = serverEnv.settingsPath;
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  // Atomic write: tmp file + rename. If the process dies after the tmp
  // is written but before rename, the next boot still sees the previous
  // good file. If it dies after rename, the file is fully written. There
  // is no window where a reader could see a half-written `settings.json`.
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

// ── Service definition ────────────────────────────────────────────────────────

/**
 * Shape accepted by `updateSettings`. Top-level fields are individually
 * optional (standard `Partial`), but `recap` is recursively partial so
 * callers can patch a single nested field (e.g. `{ recap: { agent: 'opencode' } }`)
 * without spreading the whole sub-object. {@link Settings.ts}'s
 * `updateSettings` deep-merges `recap` against the current value to honour
 * this contract.
 */
export type SettingsUpdate = Partial<Omit<UserSettings, "id" | "recap">> & {
  recap?: Partial<UserSettings["recap"]>;
};

export class SettingsService extends Context.Tag("SettingsService")<
  SettingsService,
  {
    getSettings: () => Effect.Effect<UserSettings, ValidationError>;
    updateSettings: (partial: SettingsUpdate) => Effect.Effect<UserSettings, ValidationError>;
    /**
     * Stream of settings snapshots emitted after every `updateSettings` call.
     * P4: used by OpencodeSupervisor to stop the daemon immediately when
     * `aiAgent` flips away from opencode, rather than waiting for the next
     * `jobStarted()`.
     */
    settingsChanges: () => Stream.Stream<UserSettings>;
  }
>() {}

export const SettingsServiceLive = Layer.effect(
  SettingsService,
  Effect.gen(function* () {
    // Load settings once at boot; keep in a Ref so updates are observable.
    const initial = yield* Effect.tryPromise({
      try: () => readSettingsFile(),
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
          // Deep-merge `recap`: clients commonly patch just one nested field
          // (e.g. `{ recap: { agent: 'opencode' } }`), and a shallow merge
          // would wipe out the other recap fields. Other top-level fields
          // are flat strings/numbers and merge shallowly without issue.
          const mergedRecap =
            partial.recap !== undefined ? { ...current.recap, ...partial.recap } : current.recap;
          const merged: UserSettings = {
            ...current,
            ...partial,
            recap: mergedRecap,
            id: "default",
          };
          const next: UserSettings = {
            ...merged,
            aiMaxTurns: coerceMaxTurns(merged.aiMaxTurns),
          };
          yield* Effect.tryPromise({
            try: () => writeSettingsFile(next),
            catch: (e) =>
              new ValidationError({
                message: e instanceof Error ? e.message : String(e),
              }),
          });
          yield* SubscriptionRef.set(settingsRef, next);
          return next;
        }),

      settingsChanges: () => settingsRef.changes.pipe(Stream.drop(1)), // skip initial value
    };
  }),
);
