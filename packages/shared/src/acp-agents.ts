// ── ACP agent registry (shared) ──────────────────────────────────────────────
//
// Single source of truth for the ACP (Agent Client Protocol) agents Revv can
// drive for chat and walkthrough generation. Lives in @revv/shared so BOTH the
// server (to launch the subprocess + propagate model/effort/context) and the web
// (to render the provider list + the model/effort/context selectors) consume the
// same list.
//
// Adding a new ACP-compatible agent = ONE entry below. Its id automatically
// becomes part of `AcpAgentId`, appears in the provider list, and is launchable
// — no other code changes beyond the server-only launch concerns in
// apps/server/src/ai/acp/presets.ts (overrides, availability, per-adapter model/
// effort/context injection), keyed by these same ids.

import type { ThinkingEffort } from "./types";

/** Brand-icon key — the web maps this to an icon component (generic fallback). */
export type AcpAgentIconKey = "anthropic" | "openai" | "opencode" | "cursor" | "generic";

/** A selectable model for an agent: display `label` + the id passed to the agent. */
export interface AcpAgentModel {
  readonly label: string;
  readonly value: string;
  /**
   * Thinking-effort tiers this specific model accepts, when it accepts fewer
   * than its agent does. Omitted = the agent's full
   * {@link AcpAgentCapabilities.thinkingEfforts} applies.
   *
   * Codex is the reason this exists: its reasoning ladder is per-model, not
   * per-provider (`supported_reasoning_levels` in the catalog it fetches from
   * OpenAI), so the frontier models accept tiers the older ones reject.
   */
  readonly thinkingEfforts?: readonly ThinkingEffort[];
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
   * Static model catalog (label + id), or the literal `"dynamic"` when the list
   * must be fetched live from the server (opencode runs `opencode models`). ACP
   * itself has no model protocol, so static catalogs are curated per agent.
   */
  readonly models: readonly AcpAgentModel[] | "dynamic";
  /** Whether the 200K / 1M context-window control applies (Claude Code only). */
  readonly contextWindow: boolean;
  /**
   * Thinking-effort tiers offered; empty = no thinking-effort control. Where a
   * model accepts fewer than this, it narrows the list via its own
   * {@link AcpAgentModel.thinkingEfforts} — so this is the union across the
   * agent's catalog, not a guarantee every model takes every tier. Resolve with
   * {@link getModelThinkingEfforts} rather than reading this directly.
   */
  readonly thinkingEfforts: readonly ThinkingEffort[];
  /**
   * Whether the agent supports a read-only plan turn — i.e. it advertises a
   * plan/ask/architect mode (`findPlanModeId` in chat-acp) the transport can
   * select. Drives the composer's Plan-mode toggle; when `false`, requesting
   * plan mode would 422, so the toggle stays disabled.
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

export interface AcpAgentDescriptor {
  /** Stable id — persisted as the chat-agent setting and the connection-pool key. */
  readonly id: string;
  /** Human-readable label for the provider list. */
  readonly label: string;
  /** One-line description for the agent picker / onboarding. */
  readonly description: string;
  /** Icon key the web maps to a component. */
  readonly icon: AcpAgentIconKey;
  /** argv[0] — `npx`/`bunx` to run an adapter on demand, or a binary on PATH. */
  readonly command: string;
  /** Fixed launch args. */
  readonly args: readonly string[];
  /** Model / context-window / thinking-effort surface Revv exposes for this agent. */
  readonly capabilities: AcpAgentCapabilities;
  /**
   * macOS keychain login details, when the agent stores its credential there and
   * the background server can be ACL-blocked from reading it. Absent for
   * file-based agents (codex/opencode/cursor), which the server reaches directly.
   */
  readonly keychainAuth?: AcpAgentKeychainAuth;
}

/**
 * Every thinking-effort tier, strongest first. The ordering is the contract
 * {@link clampThinkingEffort} steps down through, and the order the web renders
 * the selector in.
 */
export const THINKING_EFFORT_ORDER = [
  "ultrathink",
  "max",
  "extra-high",
  "high",
  "medium",
  "low",
] as const satisfies readonly ThinkingEffort[];

// Shared per-model effort ladders, so the Codex catalog below reads as data.
const MAX_AND_BELOW = THINKING_EFFORT_ORDER.slice(1);
const XHIGH_AND_BELOW = THINKING_EFFORT_ORDER.slice(2);

// ⇩ Add a new ACP agent here — one entry is all it takes. ⇩
export const ACP_AGENTS = [
  {
    id: "claude-code",
    label: "Claude Code",
    description: "Anthropic's reasoning model.",
    icon: "anthropic",
    command: "npx",
    args: ["-y", "@agentclientprotocol/claude-agent-acp"],
    capabilities: {
      defaultModel: "claude-sonnet-5",
      // Current-generation Anthropic models only. Opus 4.8 was dropped when
      // Opus 5 superseded it; a user still on a delisted id keeps working (the
      // value is passed through to the agent), they just can't reselect it.
      models: [
        { label: "Claude Fable 5", value: "claude-fable-5" },
        { label: "Claude Opus 5", value: "claude-opus-5" },
        { label: "Claude Sonnet 5", value: "claude-sonnet-5" },
        { label: "Claude Haiku 4.5", value: "claude-haiku-4-5-20251001" },
      ],
      contextWindow: true,
      // Claude Code takes a `MAX_THINKING_TOKENS` budget rather than a named
      // tier, so every model accepts every tier — no per-model narrowing.
      thinkingEfforts: ["ultrathink", "max", "extra-high", "high", "medium", "low"],
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
    capabilities: {
      defaultModel: "opencode/big-pickle",
      // opencode exposes 75+ models across providers; fetched live via the
      // server's `opencode models` parse rather than curated here.
      models: "dynamic",
      contextWindow: false,
      thinkingEfforts: [],
      // opencode ships a read-only `plan` agent, selected via the session's
      // advertised modes.
      planMode: true,
    },
  },
  {
    id: "codex",
    label: "Codex",
    description: "OpenAI's coding agent.",
    icon: "openai",
    command: "npx",
    args: ["-y", "@zed-industries/codex-acp"],
    capabilities: {
      defaultModel: "gpt-5.5",
      // Mirrors the `supported_reasoning_levels` Codex caches in
      // `~/.codex/models_cache.json`; re-verify against that file when OpenAI
      // ships a model. (`codex-auto-review` is in the catalog too, but it's
      // Codex's internal review model, not a selectable chat model.)
      models: [
        { label: "GPT-5.6 Sol", value: "gpt-5.6-sol" },
        { label: "GPT-5.6 Terra", value: "gpt-5.6-terra" },
        { label: "GPT-5.6 Luna", value: "gpt-5.6-luna", thinkingEfforts: MAX_AND_BELOW },
        { label: "GPT-5.5", value: "gpt-5.5", thinkingEfforts: XHIGH_AND_BELOW },
        { label: "GPT-5.4", value: "gpt-5.4", thinkingEfforts: XHIGH_AND_BELOW },
        { label: "GPT-5.4 Mini", value: "gpt-5.4-mini", thinkingEfforts: XHIGH_AND_BELOW },
      ],
      contextWindow: false,
      // Union across the catalog — Codex maps each tier onto its own
      // `model_reasoning_effort` ladder (ultrathink→ultra, extra-high→xhigh).
      // Only Sol and Terra reach the top; the rest narrow it per model above.
      thinkingEfforts: ["ultrathink", "max", "extra-high", "high", "medium", "low"],
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
    capabilities: {
      defaultModel: "auto",
      // Curated from Cursor's CLI model roster (`cursor-agent --list-models`).
      //
      // STALE — the Anthropic entries below are a generation behind (Sonnet 4.6
      // / Opus 4.7 vs Sonnet 5 / Opus 5). Not refreshed with the Claude Code and
      // Codex catalogs because `--list-models` requires a logged-in Cursor CLI
      // and the slugs are Cursor's own, not guessable from the model names. Run
      // `cursor-agent login && cursor-agent --list-models` and paste the result.
      //
      // Low blast radius today: the `cursor-agent-acp` adapter doesn't forward a
      // model, so this list is a stored preference Cursor never reads (see
      // `resolveAcpLaunchById`). It starts mattering the moment that lands.
      models: [
        { label: "Auto", value: "auto" },
        { label: "Composer 2.5", value: "composer" },
        { label: "Claude Sonnet 4.6", value: "sonnet-4.6" },
        { label: "Claude Sonnet 4.6 Thinking", value: "sonnet-4.6-thinking" },
        { label: "Claude Opus 4.7", value: "opus-4.7" },
        { label: "GPT-5.5", value: "gpt-5.5" },
        { label: "Gemini 3 Pro", value: "gemini-3-pro" },
        { label: "Grok 4", value: "grok-4" },
      ],
      contextWindow: false,
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
  // `id: AcpAgentId` is constrained to registry keys, so this is always defined.
  if (!found) throw new Error(`Unknown ACP agent id: ${id}`);
  return found;
}

/** The model / context-window / thinking-effort surface Revv exposes for an agent. */
export function getAgentCapabilities(id: AcpAgentId): AcpAgentCapabilities {
  return getAcpAgent(id).capabilities;
}

/** Revv's persisted-model default for an ACP agent. */
export function getAcpAgentDefaultModel(id: AcpAgentId): string {
  return getAcpAgent(id).capabilities.defaultModel;
}

/**
 * Thinking-effort tiers valid for one agent+model pair.
 *
 * Falls back to the agent's full list when the model declares no narrower one —
 * which covers agents with a uniform ladder (Claude Code), a dynamic catalog
 * (opencode), and any Codex model that accepts every tier. An unknown model id
 * (a stale persisted value, or one from opencode's live catalog) also gets the
 * agent-level list, since there's nothing narrower to apply.
 */
export function getModelThinkingEfforts(
  id: AcpAgentId,
  model: string | undefined,
): readonly ThinkingEffort[] {
  const caps = getAgentCapabilities(id);
  if (caps.models === "dynamic" || !model) return caps.thinkingEfforts;
  return caps.models.find((m) => m.value === model)?.thinkingEfforts ?? caps.thinkingEfforts;
}

/**
 * Clamp a selected effort to something the agent+model actually accepts.
 *
 * The persisted effort and the persisted model move independently, so a user
 * who picked Ultrathink on Sol and then switched to GPT-5.4 holds a tier that
 * model rejects. Steps down to the nearest supported tier rather than dropping
 * the setting, so "as much thinking as this model allows" survives the switch.
 * Returns `undefined` when the agent has no thinking-effort control at all.
 */
export function clampThinkingEffort(
  id: AcpAgentId,
  model: string | undefined,
  effort: ThinkingEffort | undefined,
): ThinkingEffort | undefined {
  if (!effort) return undefined;
  const allowed = getModelThinkingEfforts(id, model);
  if (allowed.length === 0) return undefined;
  if (allowed.includes(effort)) return effort;
  // THINKING_EFFORT_ORDER is strongest-first, so the first allowed tier at or
  // below the request is the nearest step down.
  const from = THINKING_EFFORT_ORDER.indexOf(effort);
  return THINKING_EFFORT_ORDER.slice(from).find((t) => allowed.includes(t)) ?? allowed[0];
}

/** Keychain-login details for an agent, or `undefined` when it isn't keychain-backed. */
export function getAgentKeychainAuth(id: AcpAgentId): AcpAgentKeychainAuth | undefined {
  return getAcpAgent(id).keychainAuth;
}

/**
 * Per-agent onboarding setup status. A single detection call resolves both
 * facts the agent step needs so the UI never races two endpoints:
 *   - `installed` — the agent's CLI is present on PATH (or pinned via the
 *     LaunchAgent `REVV_*_BIN` env vars), or — for the SDK/auth-store agents —
 *     otherwise usable.
 *   - `authed` — usable credentials are configured. opencode needs no login,
 *     so it always reports `true`.
 *   - `verified` — the provider's own status command confirmed the session.
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
 * Full onboarding detection snapshot: per-agent {@link AgentStatus} keyed by
 * registry id (so the picker renders straight from `ACP_AGENTS` and a new agent
 * surfaces automatically), plus whether this host can drive an agent's CLI
 * login inside an embedded pseudo-terminal. Revv is macOS-only, so
 * `embeddedLoginSupported` is always `true`; the per-agent `loginCommand` hint
 * remains as a manual fallback. The server is the single authority on this.
 */
export interface AgentStatusReport {
  embeddedLoginSupported: boolean;
  agents: Record<AcpAgentId, AgentStatus>;
}
