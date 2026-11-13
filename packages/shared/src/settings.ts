// Defaults, `normalizeSettings`, the server's request schema and the web's
// optimistic merge all derive from `SETTINGS_SPEC`. Adding a setting means a
// field on `UserSettings` plus its spec entry here (the compiler pairs them),
// then the DB column and the pane that renders it.

import {
  ACP_AGENT_IDS,
  type AcpAgentId,
  AUTO_SENTINEL,
  getAgentCapabilities,
  isAutoSentinel,
  THINKING_EFFORT_ORDER,
  type ThinkingEffortSetting,
} from "./acp-agents";
import {
  BASE_CONFLICT_STRATEGIES,
  type BaseConflictStrategy,
  DEFAULT_BASE_CONFLICT_STRATEGY,
} from "./base-conflicts";
import {
  AUTO_FETCH_DEFAULT_INTERVAL,
  DEFAULT_UPDATE_CHANNEL,
  UPDATE_CHANNELS,
  type UpdateChannel,
} from "./constants";
import { DEFAULT_GITHUB_HOST, normalizeGithubHost } from "./github-host";

export const DIFF_VIEW_MODES = ["unified", "split"] as const;
export type DiffViewMode = (typeof DIFF_VIEW_MODES)[number];

/**
 * Signing mode for the team cache: `strict` rejects blobs whose signature is
 * missing or invalid, `permissive` accepts them with a warning, `off` skips
 * signing and verification entirely.
 */
export const CACHE_SIGNING_MODES = ["off", "permissive", "strict"] as const;
export type CacheSigningMode = (typeof CACHE_SIGNING_MODES)[number];

/**
 * Per-feature override for which agent generates project recaps. `'auto'`
 * follows the global `aiAgent`; an explicit agent id pins recaps to it, e.g.
 * Claude Code for interactive walkthroughs but opencode for unattended recaps.
 */
export type RecapAgentChoice = "auto" | AcpAgentId;
export const RECAP_AGENT_CHOICES: readonly RecapAgentChoice[] = ["auto", ...ACP_AGENT_IDS];

export const THINKING_EFFORT_SETTINGS: readonly ThinkingEffortSetting[] = [
  AUTO_SENTINEL,
  ...THINKING_EFFORT_ORDER,
];

export const DEFAULT_ACP_AGENT: AcpAgentId = "opencode";

export const AI_MAX_TURNS = { min: 10, max: 500 } as const;

/**
 * TypeSafe System One (Jev). One switch: on runs every Jev judgment (sizing,
 * risk tier, file ranking, issue checks and severity, artifact and prose
 * checks, continuation adjudication); off makes no requests at all.
 */
export interface JevSettings {
  enabled: boolean;
  /**
   * Derived server-side from the keyring, never stored in `user_settings`:
   * `GET /api/settings` is unauthenticated. Never accepted in a patch.
   */
  hasApiKey: boolean;
}

export interface UserSettings {
  /** Drives chat and every generation pipeline; `recap.agent` may override it for recaps. */
  aiAgent: AcpAgentId;
  aiModel: string;
  aiThinkingEffort: ThinkingEffortSetting;
  /**
   * Low-cost model for one-shot, no-tools suggestion generation (right-panel
   * empty-state prompts), picked from the `aiAgent`'s catalog.
   */
  aiSuggestionsModel: string;
  /** Agent turns (tool-use round trips) allowed within one chat turn or walkthrough. */
  aiMaxTurns: number;
  diffViewMode: DiffViewMode;
  /** Minutes between background GitHub polls; `<= 0` turns polling off. */
  autoFetchInterval: number;
  /** Project-recap scheduler toggles. Cadences run on UTC boundaries. */
  recap: {
    enabled: boolean;
    dailyEnabled: boolean;
    weeklyEnabled: boolean;
    agent: RecapAgentChoice;
  };
  /** GitHub host the app authenticates against: `github.com` or a GitHub Enterprise host. */
  githubHost: string;
  /**
   * GitHub OAuth/App client ID for a user-added GitHub Enterprise host. Empty
   * for `github.com`, whose client ID comes from server config. There is no
   * bundled registration on a customer's host, so the user registers an app
   * there and pastes its public client ID. An `Iv…` prefix marks a GitHub App
   * (device flow sends no scope); `Ov…` marks a classic OAuth App.
   */
  githubClientId: string;
  /**
   * Team-shared walkthrough cache, backed by one GCS bucket whose IAM grants
   * are the team boundary. Off means no probe, no upload, no download. The
   * direction toggles let a teammate participate read-only or write-only.
   */
  cache: {
    enabled: boolean;
    bucket: string;
    uploadsEnabled: boolean;
    downloadsEnabled: boolean;
    /**
     * SSHSIG content signing: blobs are signed on push and verified on fetch,
     * with the uploader's GitHub SSH key and repo collaborator permission as
     * the trust anchor.
     */
    signing: {
      mode: CacheSigningMode;
      /** Empty = auto-detect from `~/.ssh/`. */
      keyPath: string;
      /** GitHub hosts whose signers are trusted. */
      trustedSignerHosts: string[];
    };
  };
  jev: JevSettings;
  /**
   * Release channel for the in-app updater and the `revv update` CLI. `stable`
   * tracks the latest release-please `vX.Y.Z` tag; `nightly` tracks the moving
   * `nightly` tag built on every push to `main` and skips the stable cooldown.
   */
  updateChannel: UpdateChannel;
  /** How "Resolve with agent" brings a conflicting PR up to date with its base. */
  baseConflictStrategy: BaseConflictStrategy;
}

/** A partial settings patch, accepted by the client store and `PUT /api/settings`. */
export type SettingsUpdate = Partial<Omit<UserSettings, "recap" | "cache" | "jev">> & {
  recap?: Partial<UserSettings["recap"]>;
  cache?: Partial<Omit<UserSettings["cache"], "signing">> & {
    signing?: Partial<UserSettings["cache"]["signing"]>;
  };
  jev?: Partial<Omit<JevSettings, "hasApiKey">>;
};

/** What a patch may carry for a field; the server builds its request schema from this. */
export type SettingWire =
  | { readonly type: "string"; readonly minLength?: number }
  | { readonly type: "enum"; readonly values: readonly string[] }
  | { readonly type: "number"; readonly minimum?: number; readonly maximum?: number }
  | { readonly type: "boolean" }
  | { readonly type: "string[]" }
  /** Computed by the server; never patched. */
  | { readonly type: "derived" };

export interface SettingField<T> {
  readonly default: T;
  /** The coerced value, or `undefined` when `raw` can't be one (the default applies). */
  readonly parse: (raw: unknown) => T | undefined;
  readonly wire: SettingWire;
}

type Leaf = string | number | boolean | readonly unknown[];

export type SettingsSpec<T> = {
  readonly [K in keyof T]-?: T[K] extends Leaf ? SettingField<T[K]> : SettingsSpec<T[K]>;
};

export type SettingsSpecNode = SettingField<unknown> | { readonly [key: string]: SettingsSpecNode };

export function isSettingField(node: SettingsSpecNode): node is SettingField<unknown> {
  return "wire" in node && typeof node.parse === "function";
}

const text = (fallback: string): SettingField<string> => ({
  default: fallback,
  parse: (raw) => (typeof raw === "string" ? raw : undefined),
  wire: { type: "string" },
});

/** A GitHub host, stored in its normalized form whatever form it arrived in. */
const githubHostField = (fallback: string): SettingField<string> => ({
  default: fallback,
  parse: (raw) => {
    if (typeof raw !== "string") return undefined;
    const host = normalizeGithubHost(raw);
    return host === "" ? undefined : host;
  },
  wire: { type: "string", minLength: 1 },
});

/** `aliases` maps retired stored values onto current ones. */
const oneOf = <T extends string>(
  values: readonly T[],
  fallback: T,
  aliases: Readonly<Record<string, T>> = {},
): SettingField<T> => ({
  default: fallback,
  parse: (raw) => {
    if (typeof raw !== "string") return undefined;
    return (
      values.find((v) => v === raw) ?? (Object.hasOwn(aliases, raw) ? aliases[raw] : undefined)
    );
  },
  wire: { type: "enum", values },
});

const integer = (
  fallback: number,
  bounds: { readonly min: number; readonly max: number },
): SettingField<number> => ({
  default: fallback,
  parse: (raw) =>
    typeof raw === "number" && Number.isFinite(raw)
      ? Math.min(bounds.max, Math.max(bounds.min, Math.floor(raw)))
      : undefined,
  wire: { type: "number", minimum: bounds.min, maximum: bounds.max },
});

const number = (fallback: number): SettingField<number> => ({
  default: fallback,
  parse: (raw) => (typeof raw === "number" && Number.isFinite(raw) ? raw : undefined),
  wire: { type: "number" },
});

const flag = (fallback: boolean): SettingField<boolean> => ({
  default: fallback,
  parse: (raw) => (typeof raw === "boolean" ? raw : undefined),
  wire: { type: "boolean" },
});

const textList = (fallback: readonly string[]): SettingField<string[]> => ({
  default: [...fallback],
  parse: (raw) =>
    Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : undefined,
  wire: { type: "string[]" },
});

const derivedFlag = (fallback: boolean): SettingField<boolean> => ({
  ...flag(fallback),
  wire: { type: "derived" },
});

/** Before the registry, Claude Code was stored as `claude`. */
const LEGACY_AGENT_ALIASES = { claude: "claude-code" } as const;

const defaultAgentCaps = getAgentCapabilities(DEFAULT_ACP_AGENT);

export const SETTINGS_SPEC: SettingsSpec<UserSettings> = {
  aiAgent: oneOf(ACP_AGENT_IDS, DEFAULT_ACP_AGENT, LEGACY_AGENT_ALIASES),
  aiModel: text(defaultAgentCaps.defaultModel),
  aiThinkingEffort: oneOf(THINKING_EFFORT_SETTINGS, "medium"),
  aiSuggestionsModel: text(defaultAgentCaps.suggestionsModel),
  aiMaxTurns: integer(60, AI_MAX_TURNS),
  diffViewMode: oneOf(DIFF_VIEW_MODES, "unified"),
  autoFetchInterval: number(AUTO_FETCH_DEFAULT_INTERVAL),
  recap: {
    enabled: flag(true),
    dailyEnabled: flag(true),
    weeklyEnabled: flag(true),
    agent: oneOf(RECAP_AGENT_CHOICES, "auto", LEGACY_AGENT_ALIASES),
  },
  githubHost: githubHostField(DEFAULT_GITHUB_HOST),
  githubClientId: text(""),
  cache: {
    enabled: flag(false),
    bucket: text(""),
    uploadsEnabled: flag(true),
    downloadsEnabled: flag(true),
    signing: {
      mode: oneOf(CACHE_SIGNING_MODES, "strict"),
      keyPath: text(""),
      trustedSignerHosts: textList([]),
    },
  },
  jev: {
    enabled: flag(false),
    hasApiKey: derivedFlag(false),
  },
  updateChannel: oneOf(UPDATE_CHANNELS, DEFAULT_UPDATE_CHANNEL),
  baseConflictStrategy: oneOf(BASE_CONFLICT_STRATEGIES, DEFAULT_BASE_CONFLICT_STRATEGY),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeNode(node: SettingsSpecNode, raw: unknown): unknown {
  if (isSettingField(node)) {
    const parsed = node.parse(raw);
    if (parsed !== undefined) return parsed;
    return Array.isArray(node.default) ? [...node.default] : node.default;
  }
  const record = isRecord(raw) ? raw : {};
  return Object.fromEntries(
    Object.entries(node).map(([key, child]) => [key, normalizeNode(child, record[key])]),
  );
}

/**
 * Coerce any value (a DB row's fields, a legacy JSON file, a merged patch)
 * into a complete, valid `UserSettings`. Total and idempotent: unknown or
 * invalid fields fall back to their defaults, valid ones pass through.
 */
export function normalizeSettings(raw: unknown): UserSettings {
  return normalizeNode(SETTINGS_SPEC, raw) as UserSettings;
}

export const DEFAULT_USER_SETTINGS: UserSettings = normalizeSettings(undefined);

function mergeNode(current: unknown, patch: unknown): unknown {
  if (!isRecord(current) || !isRecord(patch)) return patch;
  const merged: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) merged[key] = mergeNode(current[key], value);
  }
  return merged;
}

/** Deep-merge a patch: nested groups merge key by key, lists are replaced. */
export function mergeSettingsUpdate(current: UserSettings, patch: SettingsUpdate): UserSettings {
  return mergeNode(current, patch) as UserSettings;
}

/**
 * What picking `agent` changes alongside it: the review model is re-picked
 * from the new agent's catalog, the suggestions model reset to its cheap
 * default, and an effort tier the agent doesn't offer stepped to one it does.
 * `liveModels` is the fetched catalog for agents whose list is dynamic.
 */
export function agentChangeUpdate(
  current: Pick<UserSettings, "aiModel" | "aiThinkingEffort">,
  agent: AcpAgentId,
  liveModels: readonly string[] = [],
): SettingsUpdate {
  const caps = getAgentCapabilities(agent);
  const update: SettingsUpdate = { aiAgent: agent, aiSuggestionsModel: caps.suggestionsModel };

  if (caps.models === "dynamic") {
    // Auto routes on a static depth ladder; a live catalog has none, so the
    // sentinel is replaced too.
    update.aiModel = liveModels[0] ?? caps.defaultModel;
  } else if (!isAutoSentinel(current.aiModel)) {
    const pick = caps.models.find((m) => m.value === caps.defaultModel) ?? caps.models[0];
    if (pick) update.aiModel = pick.value;
  }

  const effort = current.aiThinkingEffort;
  if (
    caps.thinkingEfforts.length > 0 &&
    !isAutoSentinel(effort) &&
    !caps.thinkingEfforts.includes(effort)
  ) {
    const fallback = caps.thinkingEfforts.includes("high") ? "high" : caps.thinkingEfforts[0];
    if (fallback) update.aiThinkingEffort = fallback;
  }

  return update;
}

/**
 * The settings a patch produces: an agent switch brings its dependent fields
 * along (fields the patch sets itself win), then the result is normalized.
 * The server persists exactly this; the web applies it optimistically.
 */
export function applySettingsUpdate(current: UserSettings, patch: SettingsUpdate): UserSettings {
  const agent = patch.aiAgent;
  const cascaded =
    agent !== undefined && agent !== current.aiAgent
      ? { ...agentChangeUpdate(current, agent), ...patch }
      : patch;
  return normalizeSettings(mergeSettingsUpdate(current, cascaded));
}
