// Adding an ACP agent = one `ACP_AGENTS` entry plus its server adapter
// (`apps/server/src/ai/acp/agents/<id>.ts`: how model and effort reach it, its
// auth probe, its environment). Both tables are keyed by `AcpAgentId`, so a
// missing adapter is a compile error.

/**
 * Revv's thinking-effort tiers. `extra-high` is Revv's key for the providers'
 * `xhigh` level. `ultrathink` is retained only so persisted
 * `user_settings.ai_thinking_effort` rows written before the tier was retired
 * still parse; no agent offers it.
 */
export type ThinkingEffort =
  | "ultra"
  | "ultrathink"
  | "max"
  | "extra-high"
  | "high"
  | "medium"
  | "low";

/** Brand-icon key — the web maps this to an icon component (generic fallback). */
export type AcpAgentIconKey = "anthropic" | "openai" | "opencode" | "cursor" | "generic";

/** The review-depth tiers Auto model routing answers, shallowest first. */
export const REVIEW_DEPTHS = ["shallow", "standard", "deep"] as const;
export type ReviewDepth = (typeof REVIEW_DEPTHS)[number];

export interface AcpAgentModel {
  readonly label: string;
  readonly value: string;
  /** Model-specific effort limits; omitted models inherit the agent ladder. */
  readonly thinkingEfforts?: readonly ThinkingEffort[];
  /**
   * The depth tier this model sits at for Auto routing. The first model listed
   * at a tier is the one Auto picks for it; later ones are older pins that keep
   * their tier. Untagged models are off the ladder: a pin on one is left alone.
   */
  readonly reviewDepth?: ReviewDepth;
}

/**
 * What Revv can configure for a given agent. The web reads this to decide which
 * selectors to show (and with which options); the server reads it to validate /
 * default the persisted model. Anything not represented here is owned agent-side.
 */
export interface AcpAgentCapabilities {
  /** Revv's default model for this agent when no user-specific model is saved. */
  readonly defaultModel: string;
  /**
   * The cheapest reasonable model in the catalog, the default for one-shot
   * right-panel suggestions so they don't burn the review model's tokens.
   */
  readonly suggestionsModel: string;
  /**
   * Static model catalog (label + id), or the literal `"dynamic"` when the list
   * must be fetched live from the server (opencode's `GET /api/model`). The
   * other adapters publish no catalog over ACP, so theirs are curated here.
   */
  readonly models: readonly AcpAgentModel[] | "dynamic";
  /** Thinking-effort tiers offered; empty = no thinking-effort control. */
  readonly thinkingEfforts: readonly ThinkingEffort[];
  /**
   * Whether the agent supports a read-only plan turn: it advertises a
   * plan/ask/architect mode (`findPlanModeId` in `ai/acp/session-config.ts`).
   * Drives the composer's Plan-mode toggle; a plan turn on an agent without
   * one fails.
   */
  readonly planMode: boolean;
}

/**
 * Declares that an agent's login lives in the macOS login Keychain, so Revv's
 * background service may be blocked from reading it (a per-machine Access-Control
 * state) — surfacing as a 401 / "ACP connection closed". Present only for agents
 * that use the keychain; file-based agents (their config is reachable via `$HOME`)
 * omit it. Drives the keychain-access detection, probe, and remediation, so
 * covering another keychain-using provider is one more entry here — no code change.
 */
export interface AcpAgentKeychainAuth {
  /** `security` service name of the login item (e.g. `Claude Code-credentials`). */
  readonly service: string;
  /** User-facing steps to grant the background service access to that item. */
  readonly remediation: string;
}

/** The agent vendor's own CLI: what onboarding installs and signs in with. */
export interface AcpAgentCli {
  /** Binary name the installer puts on PATH, and argv[0] of the login command. */
  readonly bin: string;
  /** The vendor's one-line installer. */
  readonly install: readonly string[];
  /** Home-relative directories the installer writes `bin` to. */
  readonly installBinDirs: readonly string[];
  /**
   * Args after `bin` of the interactive login: a dedicated subcommand that
   * exits once auth completes. `null` when the agent needs no login.
   */
  readonly loginArgs: readonly string[] | null;
}

export interface AcpAgentDescriptor {
  /** Stable id — persisted as the chat-agent setting and the connection-pool key. */
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly icon: AcpAgentIconKey;
  /** argv[0] — `npx`/`bunx` to run an adapter on demand, or a binary on PATH. */
  readonly command: string;
  readonly args: readonly string[];
  readonly capabilities: AcpAgentCapabilities;
  readonly cli: AcpAgentCli;
  /**
   * The mode Revv puts every session in when it opens or reloads it, so the
   * agent asks Revv for permissions rather than deciding them itself. Absent
   * when the agent's own starting mode already does that.
   */
  readonly sessionMode?: string;
  readonly keychainAuth?: AcpAgentKeychainAuth;
}

/** Every thinking-effort tier, strongest first — the order the web renders. */
export const THINKING_EFFORT_ORDER = [
  "ultra",
  "ultrathink",
  "max",
  "extra-high",
  "high",
  "medium",
  "low",
] as const satisfies readonly ThinkingEffort[];

export const ACP_AGENTS = [
  {
    id: "claude-code",
    label: "Claude Code",
    description: "Anthropic's reasoning model.",
    icon: "anthropic",
    command: "npx",
    args: ["-y", "@agentclientprotocol/claude-agent-acp"],
    // Since 0.101.0 the adapter starts sessions in Auto mode, where Claude
    // Code's classifier approves tools instead of Revv: a model call per tool,
    // and the plan-mode guard in `acp-connection.ts` never runs.
    sessionMode: "default",
    cli: {
      bin: "claude",
      install: ["bash", "-c", "curl -fsSL https://claude.ai/install.sh | bash"],
      installBinDirs: [".local/bin"],
      // `/login` is the in-REPL slash command, not a subcommand. `--claudeai`
      // signs in with the subscription; `--console` would be API billing.
      loginArgs: ["auth", "login", "--claudeai"],
    },
    capabilities: {
      defaultModel: "claude-sonnet-5-5",
      suggestionsModel: "claude-haiku-4-5-20251001",
      // Verified against https://code.claude.com/docs/en/model-config (2026-10-13).
      // Keep Sonnet 5 and Haiku 4.5 selectable for existing installations.
      models: [
        { label: "Claude Fable 5.1", value: "claude-fable-5-1" },
        { label: "Claude Opus 5.5", value: "claude-opus-5-5", reviewDepth: "deep" },
        { label: "Claude Sonnet 5.5", value: "claude-sonnet-5-5", reviewDepth: "standard" },
        { label: "Claude Sonnet 5", value: "claude-sonnet-5", reviewDepth: "standard" },
        { label: "Claude Haiku 5.5", value: "claude-haiku-5-5", reviewDepth: "shallow" },
        {
          label: "Claude Haiku 4.5",
          value: "claude-haiku-4-5-20251001",
          thinkingEfforts: [],
          reviewDepth: "shallow",
        },
      ],
      // Claude Code's named effort ladder tops out at `max`. `ultrathink` is
      // retained in the persisted type and mapped to `max` at launch.
      thinkingEfforts: ["max", "extra-high", "high", "medium", "low"],
      // claude-agent-acp advertises a read-only plan mode.
      planMode: true,
    },
    keychainAuth: {
      service: "Claude Code-credentials",
      remediation:
        "Revv's background service isn't allowed to read your Claude subscription login from " +
        "the macOS Keychain, so the Claude Code agent can't authenticate. To grant access: open " +
        'Keychain Access, search "Claude Code-credentials" — an isolated Revv session may show ' +
        'it as "Claude Code-credentials-<hash>" instead — double-click the matching item, open ' +
        'the Access Control tab, choose "Allow all applications to access this item", and Save ' +
        "Changes. Then retry.",
    },
  },
  {
    id: "opencode",
    label: "opencode",
    description: "Local engine, works out of the box.",
    icon: "opencode",
    command: "opencode",
    args: ["acp"],
    cli: {
      bin: "opencode",
      install: ["bash", "-c", "curl -fsSL https://opencode.ai/install | bash"],
      installBinDirs: [".opencode/bin", ".local/bin"],
      loginArgs: null,
    },
    capabilities: {
      defaultModel: "opencode/big-pickle",
      suggestionsModel: "opencode/big-pickle",
      // opencode exposes 75+ models across providers; fetched live from its
      // server API rather than curated here, and applied per session through
      // the ACP `model` config option.
      models: "dynamic",
      thinkingEfforts: [],
      // opencode ships a read-only `plan` agent, advertised as the session's
      // `mode` config option.
      planMode: true,
    },
  },
  {
    id: "codex",
    label: "Codex",
    description: "OpenAI's coding agent.",
    icon: "openai",
    command: "npx",
    args: ["-y", "@agentclientprotocol/codex-acp"],
    cli: {
      bin: "codex",
      install: ["bash", "-c", "curl -fsSL https://chatgpt.com/codex/install.sh | sh"],
      installBinDirs: [".local/bin"],
      loginArgs: ["login"],
    },
    capabilities: {
      defaultModel: "gpt-6.1-sol",
      suggestionsModel: "gpt-6-luna",
      // This maintained adapter embeds a current Codex App Server, so the
      // selector can expose the current GPT-6 family. GPT-6.1 Sol is Codex's
      // recommended default; GPT-6 Sol has left the docs but stays listed for
      // existing installations. Do not replace it with the deprecated `@zed-industries/codex-acp`: that
      // adapter embeds an older Codex core which rejects current models.
      models: [
        // https://learn.chatgpt.com/docs/models (2026-10-13).
        { label: "GPT-6 Astra", value: "gpt-6-astra" },
        { label: "GPT-6.1 Sol", value: "gpt-6.1-sol" },
        { label: "GPT-6 Sol", value: "gpt-6-sol" },
        {
          label: "GPT-6 Luna",
          value: "gpt-6-luna",
          thinkingEfforts: ["max", "extra-high", "high", "medium", "low"],
        },
      ],
      // Ultra is a Codex control; Luna tops out at Max.
      thinkingEfforts: ["ultra", "max", "extra-high", "high", "medium", "low"],
      // Codex requires danger-full-access for MCP tool execution, so there is
      // no enforceable read-only plan turn yet.
      planMode: false,
    },
  },
  {
    id: "cursor",
    label: "Cursor",
    description: "Cursor's coding agent.",
    icon: "cursor",
    command: "npx",
    args: ["-y", "cursor-agent-acp"],
    cli: {
      // Cursor's docs alias the binary as `agent`; the installed one is `cursor-agent`.
      bin: "cursor-agent",
      install: ["bash", "-c", "curl https://cursor.com/install -fsS | bash"],
      installBinDirs: [".local/bin"],
      loginArgs: ["login"],
    },
    capabilities: {
      defaultModel: "auto",
      suggestionsModel: "auto",
      // https://cursor.com/docs/models-and-pricing (2026-10-13). The
      // ACP adapter does not yet forward a selected model, so this remains a
      // stored preference until it gains a model passthrough.
      models: [
        { label: "Auto", value: "auto" },
        { label: "Claude Fable 5.1", value: "claude-fable-5-1" },
        { label: "Claude Opus 5.5", value: "claude-opus-5-5" },
        { label: "Claude Sonnet 5.5", value: "claude-sonnet-5-5" },
        { label: "Claude Haiku 5.5", value: "claude-haiku-5-5" },
        { label: "Composer 2.5", value: "composer-2.5" },
        { label: "Gemini 3.1 Pro", value: "gemini-3.1-pro" },
        { label: "Gemini 3.8 Flash", value: "gemini-3.8-flash" },
        { label: "GPT-5.6 Sol", value: "gpt-5.6-sol" },
        { label: "GPT-5.6 Terra", value: "gpt-5.6-terra" },
        { label: "GPT-5.6 Luna", value: "gpt-5.6-luna" },
        { label: "Grok 4.7", value: "grok-4.7" },
        { label: "Grok 4.6", value: "grok-4.6" },
        { label: "Grok 4.5", value: "grok-4.5" },
        { label: "Kimi K3", value: "kimi-k3" },
        { label: "GLM 5.3", value: "glm-5.3" },
        { label: "Muse Spark 1.3", value: "muse-spark-1.3" },
      ],
      thinkingEfforts: [],
      // Cursor degrades generically over ACP (no resume, no MCP tools) and
      // advertises no read-only/plan mode.
      planMode: false,
    },
  },
] as const satisfies readonly AcpAgentDescriptor[];

export type AcpAgentId = (typeof ACP_AGENTS)[number]["id"];

export const ACP_AGENT_IDS: readonly AcpAgentId[] = ACP_AGENTS.map((a) => a.id);

export function isAcpAgentId(value: string): value is AcpAgentId {
  return ACP_AGENTS.some((a) => a.id === value);
}

export function getAcpAgent(id: AcpAgentId): AcpAgentDescriptor {
  const found = ACP_AGENTS.find((a) => a.id === id);
  if (!found) throw new Error(`Unknown ACP agent id: ${id}`);
  return found;
}

export function getAgentCapabilities(id: AcpAgentId): AcpAgentCapabilities {
  return getAcpAgent(id).capabilities;
}

/** Effort choices for the selected model, or the agent default when unpinned. */
export function getModelThinkingEfforts(id: AcpAgentId, model?: string): readonly ThinkingEffort[] {
  const caps = getAgentCapabilities(id);
  const selected = model && !isAutoSentinel(model) ? model : caps.defaultModel;
  return (
    (caps.models === "dynamic"
      ? undefined
      : caps.models.find((m) => m.value === selected)?.thinkingEfforts) ?? caps.thinkingEfforts
  );
}

export function getAcpAgentDefaultModel(id: AcpAgentId): string {
  return getAcpAgent(id).capabilities.defaultModel;
}

/**
 * Stored in `aiModel` or `aiThinkingEffort` to mean "don't pin one — size the
 * PR and pick". Only consulted when the TypeSafe auto-model toggle is on.
 *
 * Namespaced because plain `"auto"` is already taken by `cursor`'s own model.
 *
 * Absent from every agent's `capabilities.models` / `.thinkingEfforts`.
 * {@link resolveGenerationModel} and {@link resolveThinkingEffort} are the
 * arbiters that collapse it to "unpinned" — every launch path must go
 * through one of them, or a raw `settings.aiModel` reaches the agent adapter
 * as `"revv:auto"` and the launch fails.
 */
export const AUTO_SENTINEL = "revv:auto";

export type AutoSentinel = typeof AUTO_SENTINEL;

export function isAutoSentinel(value: string | null | undefined): value is AutoSentinel {
  return value === AUTO_SENTINEL;
}

export type ThinkingEffortSetting = ThinkingEffort | AutoSentinel;

/**
 * Resolve the stored effort setting into a concrete tier for a launch.
 * `undefined` means "let the agent use its own default" — what Auto resolves
 * to wherever there's no sizing answer (chat, recap, suggestions). Only
 * walkthrough generation sizes the PR, so only it passes a `sized` value.
 */
export function resolveThinkingEffort(
  setting: ThinkingEffortSetting | null | undefined,
  sized?: ThinkingEffort | null,
): ThinkingEffort | undefined {
  if (setting === null || setting === undefined) return undefined;
  if (isAutoSentinel(setting)) return sized ?? undefined;
  return setting;
}

/**
 * Clamp a selected effort to a tier the agent actually accepts.
 *
 * Effort and agent are persisted independently, so a tier picked on one agent
 * outlives a switch to another that tops out lower — and an out-of-range tier
 * is not inert: Codex's adapter fails to parse a `model_reasoning_effort` it
 * doesn't know. Steps down to the nearest supported tier rather than dropping
 * the setting, so "as much thinking as this agent allows" survives the switch.
 * Returns `undefined` when the agent has no thinking-effort control at all.
 */
export function clampThinkingEffort(
  id: AcpAgentId,
  effort: ThinkingEffort | undefined,
  model?: string,
): ThinkingEffort | undefined {
  if (!effort) return undefined;
  const allowed = getModelThinkingEfforts(id, model);
  if (allowed.length === 0) return undefined;
  if (allowed.includes(effort)) return effort;
  const from = THINKING_EFFORT_ORDER.indexOf(effort);
  return THINKING_EFFORT_ORDER.slice(from).find((t) => allowed.includes(t)) ?? allowed[0];
}

export function getAgentKeychainAuth(id: AcpAgentId): AcpAgentKeychainAuth | undefined {
  return getAcpAgent(id).keychainAuth;
}

/**
 * Per-agent onboarding setup status, resolved in one detection call so the UI
 * never races two endpoints:
 *   - `installed` — the agent's CLI is present on PATH (or pinned via the
 *     LaunchAgent `REVV_*_BIN` env vars).
 *   - `authed` — usable credentials are configured. opencode needs no login,
 *     so it always reports `true`.
 * `loginCommand` is the agent's official interactive login command (joined
 * argv), surfaced so the UI can show a manual hint where the embedded PTY login
 * isn't available; `null` for agents that need no login (opencode).
 */
export interface AgentStatus {
  installed: boolean;
  authed: boolean;
  /**
   * `true` only when the provider's own status command confirms the session.
   * Env keys and credential files can make an agent usable, but they are
   * reported as configured rather than verified unless the provider can prove
   * the connection without starting a generation.
   */
  verified: boolean;
  authSource:
    | "none"
    | "not-required"
    | "subscription"
    | "api-key"
    | "local-credentials"
    | "unknown";
  authLabel: string;
  authWarning: string | null;
  loginCommand: string | null;
}

/**
 * `embeddedLoginSupported`: whether this host can drive an agent's CLI login
 * inside an embedded pseudo-terminal. Revv is macOS-only, so it is always
 * `true`; the per-agent `loginCommand` hint remains as a manual fallback.
 */
export interface AgentStatusReport {
  embeddedLoginSupported: boolean;
  agents: Record<AcpAgentId, AgentStatus>;
}

/**
 * Result of Settings' agent test: one real turn through the same ACP path
 * reviews use, run by the server. `guidance` is the sign-in / Keychain advice
 * for auth-shaped failures, `null` otherwise.
 */
export type AgentCheckResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string; readonly guidance: string | null };
