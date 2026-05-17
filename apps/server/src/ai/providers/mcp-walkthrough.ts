// ─── mcp-walkthrough ────────────────────────────────────────────────────────
//
// Claude Agent SDK driver. Registers the SHARED phase-bound tool handlers
// (from walkthrough-tools.ts) as in-process MCP tools. Per doctrine invariant
// #13 (Agent-path parity), the handlers run here via the SDK's `mcpServers`
// config AND the HTTP MCP route (used by opencode) run the same code — one
// source of truth, two drivers.
//
// Streaming decode (content-block extraction from SDK messages) lives in
// `../agent-stream.ts`. This file owns walkthrough-specific concerns: the
// phase state machine, the event-queue/async-generator pattern, the SDK
// options shape, and the mapping from `NormalizedAgentEvent` to
// `WalkthroughStreamEvent`.

import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  RatingAxis,
  UserSettings,
  WalkthroughBlock,
  WalkthroughStreamEvent,
  WalkthroughTokenUsage,
  WsServerMessage,
} from "@revv/shared";
import { Effect } from "effect";
import { WALKTHROUGH_HEARTBEAT_MS } from "../../constants";
import type { Db } from "../../db";
import { debug, logError } from "../../logger";
import { AppRuntime } from "../../runtime";
import type { PrFileMeta } from "../../services/GitHub";
import { WebSocketHub } from "../../services/WebSocketHub";
import { buildActivity, type NormalizedAgentEvent, walkClaudeMessages } from "../agent-stream";
import { buildWalkthroughPrompt, WALKTHROUGH_MCP_SYSTEM_PROMPT } from "../prompts/walkthrough";
import { resolveCliBin } from "./cli-agent";
import { createWalkthroughMcpServer, TOOL_SPECS } from "./walkthrough-tools";

// ── Continuation context ─────────────────────────────────────────────────────

/**
 * Informational context passed into the provider on resume. Note: under the
 * new doctrine, the agent no longer CONSUMES this (it calls
 * `get_walkthrough_state` via MCP instead). Kept for the provider's own
 * bookkeeping — e.g. opencode uses `opencodeSessionId` for `--continue`.
 */
export interface ContinuationContext {
  walkthroughId: string;
  existingBlocks: WalkthroughBlock[];
  existingIssueCount: number;
  existingRatedAxes: RatingAxis[];
  opencodeSessionId?: string;
}

// ── Built-in tools the model can use for file exploration ───────────────────

const EXPLORATION_TOOLS = new Set(["Read", "Grep", "Glob", "Bash"]);

const WALKTHROUGH_MCP_SERVER = "revv-walkthrough";
const MCP_TOOL_PREFIX = `mcp__${WALKTHROUGH_MCP_SERVER}__`;

// ── Allowed tools (derived from TOOL_SPECS) ─────────────────────────────────
//
// Derived from TOOL_SPECS so new tool additions are always reflected here.
// A runtime assertion checks the count — a new spec that slips in without
// being added here will cause a clear error at startup rather than silently
// stalling the agent (the old hazard this list had).

const ALLOWED_TOOLS: readonly string[] = [
  // Built-in exploration
  "Read",
  "Grep",
  "Glob",
  // MCP tools — derived from TOOL_SPECS (11 specs → 11 entries)
  ...TOOL_SPECS.map((s) => `${MCP_TOOL_PREFIX}${s.name}`),
] as const;

// Verify we have exactly 14 entries (3 built-ins + 11 MCP tools).
// If this fails, a new TOOL_SPECS entry was added without updating ALLOWED_TOOLS.
if (ALLOWED_TOOLS.length !== 14) {
  throw new Error(
    `ALLOWED_TOOLS has ${ALLOWED_TOOLS.length} entries, expected 14. ` +
      "A new TOOL_SPECS entry was added without updating ALLOWED_TOOLS.",
  );
}

// ── Thinking effort → Claude Agent SDK options ───────────────────────────────
//
// User-facing setting (UI) maps to a small set of SDK-level knobs. We keep
// this mapping isolated here so changing the UI vocabulary doesn't ripple.

function applyThinkingEffort(effort: UserSettings["aiThinkingEffort"]): Record<string, unknown> {
  // The Claude Agent SDK's `query()` accepts thinking-budget-adjacent options
  // through its underlying Anthropic thinking API. Currently the SDK exposes
  // `thinkingBudgetTokens` on Sonnet-family models. We translate our UI
  // vocabulary into conservative budgets; unrecognized values fall back to
  // the SDK default (no explicit budget).
  switch (effort) {
    case "ultrathink":
      return { thinkingBudgetTokens: 32000 };
    case "max":
      return { thinkingBudgetTokens: 16000 };
    case "extra-high":
      return { thinkingBudgetTokens: 8000 };
    case "high":
      return { thinkingBudgetTokens: 4000 };
    case "medium":
      return { thinkingBudgetTokens: 2000 };
    case "low":
      return { thinkingBudgetTokens: 1000 };
    default:
      return {};
  }
}

// ── Phase state machine (walkthrough-only) ──────────────────────────────────
//
// The walkthrough UI tracks a 5-step progress arc (`connecting → exploring →
// analyzing → writing → rating → finishing`). Phase transitions are driven
// by MCP tool names: `set_overview` → analyzing, `add_diff_step` → writing,
// `rate_axis` → rating, `complete_walkthrough` → finishing. Once a phase is
// reached we don't roll back, so each branch double-checks `currentPhase`
// before pushing.
//
// Shared between this driver and `mcp-walkthrough-opencode.ts` only through
// shape, not code — opencode bakes its own variant inline because the phase
// pushes ALSO drive its stream-guard heartbeat, which has slightly different
// rules. The duplication is intentional and minor.

type Phase = "connecting" | "exploring" | "analyzing" | "writing" | "rating" | "finishing";

interface PhaseMachine {
  readonly current: () => Phase;
  /** Most recent message paired with `current()`. Used by the periodic
   *  heartbeat (WALKTHROUGH_HEARTBEAT_MS) to re-emit a stable phase event
   *  without UI churn. Returns a generic placeholder until the first
   *  transition fires. */
  readonly currentMessage: () => string;
  readonly transition: (next: Phase, message: string) => WalkthroughStreamEvent | null;
}

function createPhaseMachine(): PhaseMachine {
  let phase: Phase = "connecting";
  let message = "Starting up...";
  return {
    current: () => phase,
    currentMessage: () => message,
    transition: (next, msg) => {
      if (phase === next) return null;
      phase = next;
      message = msg;
      return { type: "phase", data: { phase: next, message: msg } };
    },
  };
}

// MCP tool bare-name → phase transition. Returns the new phase + message
// pair, or null if the tool doesn't drive a transition.
function phaseForMcpTool(bareName: string): { phase: Phase; message: string } | null {
  switch (bareName) {
    case "set_overview":
      return { phase: "analyzing", message: "Forming assessment and risk analysis..." };
    case "add_semantic_step":
    case "add_diff_step":
      return { phase: "writing", message: "Building walkthrough..." };
    case "rate_axis":
      return { phase: "rating", message: "Scoring the PR across 9 axes..." };
    case "complete_walkthrough":
      return { phase: "finishing", message: "Wrapping up..." };
    default:
      return null;
  }
}

// Phases follow A→B→C→D; once past "writing" we don't roll back to
// "exploring" just because the agent re-checks a file (helper for the
// guard).
const PHASE_ORDER: Phase[] = [
  "connecting",
  "exploring",
  "analyzing",
  "writing",
  "rating",
  "finishing",
];
function isForward(current: Phase, next: Phase): boolean {
  return PHASE_ORDER.indexOf(next) >= PHASE_ORDER.indexOf(current);
}

// ── Main entry point ────────────────────────────────────────────────────────

/**
 * Stream walkthrough via Claude Agent SDK with MCP tool calls.
 *
 * The SDK registers our shared phase-bound tool handlers (from
 * walkthrough-tools.ts) as in-process MCP tools. Each handler commits its
 * write to SQLite inside a transaction (doctrine invariant #3), then emits
 * a WalkthroughStreamEvent which this generator surfaces.
 */
export function streamWalkthroughViaMCP(
  params: {
    walkthroughId: string;
    db: Db;
    pr: {
      title: string;
      body: string | null;
      sourceBranch: string;
      targetBranch: string;
      url: string;
    };
    files: PrFileMeta[];
    worktreePath: string;
    continuation?: ContinuationContext;
    abortController?: AbortController;
    /** Route MCP tool events through WalkthroughJobs.emitEvent (P1). Falls back to local push if not provided. */
    emitEvent?: (event: WalkthroughStreamEvent) => void;
  },
  model?: string,
  settings?: UserSettings,
): AsyncGenerator<WalkthroughStreamEvent> {
  // ── Shared event queue + waiter pattern ──────────────────────────────
  const events: WalkthroughStreamEvent[] = [];
  let waiter: { resolve: () => void } | null = null;
  let queryDone = false;

  function push(event: WalkthroughStreamEvent) {
    events.push(event);
    if (waiter) {
      waiter.resolve();
      waiter = null;
    }
  }

  // Fire-and-forget WebSocket broadcaster used by tools that mutate
  // non-walkthrough tables (currently only `add_issue_comment` →
  // `comment_threads`). Same shape as the HTTP MCP path so handler behavior
  // is byte-identical across transports (doctrine invariant #13).
  const broadcastThreadEvent = (msg: WsServerMessage): void => {
    void AppRuntime.runPromise(Effect.flatMap(WebSocketHub, (hub) => hub.broadcast(msg))).catch(
      (err) => {
        logError(
          "walkthrough-mcp",
          "broadcastThreadEvent failed:",
          err instanceof Error ? err.message : String(err),
        );
      },
    );
  };

  // Route MCP tool handler events through WalkthroughJobs.emitEvent when
  // provided (P1). This makes both Claude and opencode emit from the same
  // site. Fall back to local push for standalone/test usage.
  const emitFn = params.emitEvent ?? push;

  // Shared tool handlers run with this context. No mutable "state" object
  // anymore — all state lives in the DB (doctrine invariant #1).
  const walkthroughServer = createWalkthroughMcpServer({
    db: params.db,
    walkthroughId: params.walkthroughId,
    emit: emitFn,
    broadcastThreadEvent,
  });

  const userMessage = buildWalkthroughPrompt(params, undefined, params.continuation);

  let errorEmitted = false;
  let anySummaryEmitted = false;

  const queryTask = (async (): Promise<WalkthroughTokenUsage> => {
    debug(
      "walkthrough-mcp",
      "Starting MCP walkthrough in:",
      params.worktreePath,
      "model:",
      model ?? "default",
    );

    const abortController = params.abortController ?? new AbortController();
    const timeoutId = setTimeout(
      () => {
        debug("walkthrough-mcp", "Aborting walkthrough — timed out after 10 minutes");
        abortController.abort(new Error("Walkthrough generation timed out after 10 minutes"));
      },
      10 * 60 * 1000,
    );

    const phaseMachine = createPhaseMachine();

    // Periodic phase heartbeat — guarantees the stream guard sees an event
    // every WALKTHROUGH_HEARTBEAT_MS while the Claude SDK query is in flight,
    // even when the model is thinking deeply between tool calls (extended
    // thinking can be quiet for >2 min). Re-emits the current phase + last
    // message so the UI stays stable.
    const heartbeatInterval = setInterval(() => {
      if (queryDone || errorEmitted) return;
      push({
        type: "phase",
        data: { phase: phaseMachine.current(), message: phaseMachine.currentMessage() },
      });
    }, WALKTHROUGH_HEARTBEAT_MS);

    try {
      const pinnedClaude = resolveCliBin("claude");
      const pathOption =
        pinnedClaude !== "claude" ? { pathToClaudeCodeExecutable: pinnedClaude } : {};

      const thinkingOptions = settings?.aiThinkingEffort
        ? applyThinkingEffort(settings.aiThinkingEffort)
        : {};

      const q = query({
        prompt: userMessage,
        options: {
          systemPrompt: WALKTHROUGH_MCP_SYSTEM_PROMPT,
          cwd: params.worktreePath,
          tools: ["Read", "Grep", "Glob"],
          allowedTools: [...ALLOWED_TOOLS] as string[],
          mcpServers: { [WALKTHROUGH_MCP_SERVER]: walkthroughServer },
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          persistSession: false,
          // 9 rate_axis calls layered on top of the N add_diff_step
          // calls + flag_issue + set_overview + set_sentiment. The
          // ceiling is user-configurable via `aiMaxTurns` so complex
          // PRs don't truncate. Default 60 matches the historical
          // hard-coded value.
          maxTurns: settings?.aiMaxTurns ?? 60,
          abortController,
          ...(model ? { model } : {}),
          ...pathOption,
          ...thinkingOptions,
        },
      });

      // Walkthrough doesn't surface text/reasoning to the UI — content
      // flows commit-first through MCP tool handlers. Tool calls drive
      // either an `exploration` event (built-in tools) or a phase
      // transition (MCP walkthrough tools).
      const emit = (ev: NormalizedAgentEvent): void => {
        if (ev.kind !== "tool-call") return;

        if (ev.source === "builtin" && EXPLORATION_TOOLS.has(ev.toolName)) {
          if (phaseMachine.current() === "connecting") {
            const transition = phaseMachine.transition(
              "exploring",
              "Reading files and understanding changes...",
            );
            if (transition) push(transition);
          }
          const activity = buildActivity(ev.toolName, ev.input);
          push({ type: "exploration", data: activity });
          return;
        }

        if (ev.source === "mcp" && ev.mcpServer === WALKTHROUGH_MCP_SERVER) {
          if (ev.bareName === "set_overview") {
            anySummaryEmitted = true;
          }
          const phaseTarget = phaseForMcpTool(ev.bareName);
          if (phaseTarget && isForward(phaseMachine.current(), phaseTarget.phase)) {
            const transition = phaseMachine.transition(phaseTarget.phase, phaseTarget.message);
            if (transition) push(transition);
          }
        }
      };

      const tokenUsage = await walkClaudeMessages(q, emit);

      debug("walkthrough-mcp", "Query complete.");
      return (
        tokenUsage ?? {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        }
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      debug("walkthrough-mcp", "Query error/abort:", message);
      errorEmitted = true;
      push({
        type: "error",
        data: { code: "AiGenerationError", message },
      });
      return {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      };
    } finally {
      clearTimeout(timeoutId);
      clearInterval(heartbeatInterval);
    }
  })();

  return (async function* (): AsyncGenerator<WalkthroughStreamEvent> {
    const resultPromise = queryTask.then((usage) => {
      queryDone = true;
      if (waiter) {
        waiter.resolve();
        waiter = null;
      }
      return usage;
    });

    while (true) {
      if (events.length > 0) {
        const batch = events.splice(0);
        for (const e of batch) {
          yield e;
        }
      } else if (queryDone) {
        break;
      } else {
        await new Promise<void>((resolve) => {
          waiter = { resolve };
        });
      }
    }

    for (const e of events.splice(0)) {
      yield e;
    }

    const tokenUsage = await resultPromise;

    if (anySummaryEmitted) {
      yield {
        type: "done" as const,
        data: {
          walkthroughId: params.walkthroughId,
          tokenUsage,
        },
      };
    } else if (!errorEmitted) {
      debug(
        "walkthrough-mcp",
        "Query completed without producing a summary — emitting fallback error",
      );
      yield {
        type: "error" as const,
        data: {
          code: "NoSummaryGenerated",
          message:
            "The AI finished exploring but did not produce a walkthrough. This can happen with complex PRs. Try regenerating.",
        },
      };
    }
  })();
}
