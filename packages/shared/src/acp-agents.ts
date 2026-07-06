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
}

/**
 * What Revv can configure for a given agent. The web reads this to decide which
 * selectors to show (and with which options); the server reads it to validate /
 * default the persisted model. Anything not represented here is owned agent-side.
 */
export interface AcpAgentCapabilities {
  /**
   * Static model catalog (label + id), or the literal `"dynamic"` when the list
   * must be fetched live from the server (opencode runs `opencode models`). ACP
   * itself has no model protocol, so static catalogs are curated per agent.
   */
  readonly models: readonly AcpAgentModel[] | "dynamic";
  /** Whether the 200K / 1M context-window control applies (Claude Code only). */
  readonly contextWindow: boolean;
  /** Thinking-effort tiers offered; empty = no thinking-effort control. */
  readonly thinkingEfforts: readonly ThinkingEffort[];
  /**
   * Whether the agent supports a read-only plan turn — i.e. it advertises a
   * plan/ask/architect mode (`findPlanModeId` in chat-acp) the transport can
   * select. Drives the composer's Plan-mode toggle; when `false`, requesting
   * plan mode would 422, so the toggle stays disabled.
   */
  readonly planMode: boolean;
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
}

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
      models: [
        { label: "Claude Opus 4.8", value: "claude-opus-4-8" },
        { label: "Claude Sonnet 4.6", value: "claude-sonnet-4-6" },
        { label: "Claude Haiku 4.5", value: "claude-haiku-4-5-20251001" },
      ],
      contextWindow: true,
      thinkingEfforts: ["ultrathink", "max", "extra-high", "high", "medium", "low"],
      // claude-agent-acp advertises a read-only plan mode.
      planMode: true,
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
      models: [
        { label: "GPT-5.5", value: "gpt-5.5" },
        { label: "GPT-5.4", value: "gpt-5.4" },
        { label: "GPT-5.4 Mini", value: "gpt-5.4-mini" },
        { label: "GPT-5.3 Codex", value: "gpt-5.3-codex" },
        { label: "GPT-5.2", value: "gpt-5.2" },
      ],
      contextWindow: false,
      // Codex maps these onto its `model_reasoning_effort` (no ultrathink/max).
      thinkingEfforts: ["extra-high", "high", "medium", "low"],
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
      // Curated from Cursor's CLI model roster (`cursor-agent --list-models`).
      // Re-verify when Cursor ships/retires models.
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
 * login inside an embedded pseudo-terminal. The embedded PTY is POSIX-only, so
 * `embeddedLoginSupported` is `false` on Windows and the UI falls back to the
 * per-agent `loginCommand` hint. The server is the single authority on this.
 */
export interface AgentStatusReport {
  embeddedLoginSupported: boolean;
  agents: Record<AcpAgentId, AgentStatus>;
}
