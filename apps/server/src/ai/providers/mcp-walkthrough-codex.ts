// ─── mcp-walkthrough-codex ──────────────────────────────────────────────────
//
// Codex driver. Like the Claude path it drives the agent IN-PROCESS — the
// `@openai/codex-sdk` spawns and manages the `codex` subprocess itself, so
// there is no daemon supervisor. Like the opencode path it routes all tool
// handling through the SHARED HTTP MCP route (`routes/mcp/walkthrough.ts`),
// which it registers on the codex CLI via the SDK `config.mcp_servers` map
// with a bearer token in `http_headers`. Per doctrine invariant #13 the tool
// handlers — and therefore the externally-observable behavior — are identical
// across all three providers.
//
// This file owns codex-specific session driving only:
//   1. Mint a one-time session token from WalkthroughJobs.
//   2. Construct a `Codex` instance with `/mcp/walkthrough` baked into
//      `config.mcp_servers` (bearer token in headers — baked at construction,
//      so the token must be minted first).
//   3. start/resume a thread and `runStreamed` the prompt, walking the event
//      stream via the shared `walkCodexEvents` decoder. MCP tool-call content
//      does NOT flow through here — the HTTP route handlers already emitted it
//      via WalkthroughJobs.emitEvent (commit-first, invariant #8).
//   4. Thread the caller's AbortController straight into `runStreamed`'s signal
//      via `withAgentTurn` (no-op refcount — there is no daemon to refcount).

import { Codex } from "@openai/codex-sdk";
import type {
  UserSettings,
  WalkthroughLifecyclePhase,
  WalkthroughStreamEvent,
  WalkthroughTokenUsage,
} from "@revv/shared";
import { eq } from "drizzle-orm";
import { serverEnv } from "../../config";
import { CLI_WALKTHROUGH_TIMEOUT_MS, WALKTHROUGH_HEARTBEAT_MS } from "../../constants";
import type { Db } from "../../db";
import { walkthroughs as walkthroughsTable } from "../../db/schema/walkthroughs";
import { debug, logError } from "../../logger";
import type { PrFileMeta } from "../../services/GitHub";
import {
  buildActivity,
  type NormalizedAgentEvent,
  walkCodexEvents,
  withAgentTurn,
} from "../agent-stream";
import { buildWalkthroughPrompt, WALKTHROUGH_MCP_SYSTEM_PROMPT } from "../prompts/walkthrough";
import { resolveCliBin } from "./cli-agent";
import type { ContinuationContext } from "./mcp-walkthrough";
import { TOOL_SPECS } from "./walkthrough-tools";

// ── Built-in exploration tool surface ───────────────────────────────────────
const EXPLORATION_TOOLS = new Set(["Read", "Grep", "Glob", "Bash", "Write", "Edit"]);

const WALKTHROUGH_MCP_SERVER = "revv-walkthrough";

// ── Deps injected by the caller (AiService) ──────────────────────────────────
//
// A strict subset of `OpencodeProviderDeps` — codex needs the HTTP-MCP session
// token + the activity heartbeat notifier, but NONE of the daemon lifecycle
// callbacks (the SDK owns the subprocess).

export interface CodexProviderDeps {
  /** Mint a session token bound to this walkthroughId. */
  issueSessionToken: (walkthroughId: string) => Promise<string>;
  /** Invalidate the token when we're done. */
  clearSessionToken: (token: string) => Promise<void>;
  /** Register a heartbeat notifier so the stream guard timer resets on each MCP tool call. */
  registerActivityNotifier: (
    walkthroughId: string,
    callback: (event: WalkthroughStreamEvent) => void,
  ) => Promise<void>;
  /** Unregister the heartbeat notifier (called from finally). */
  unregisterActivityNotifier: (walkthroughId: string) => Promise<void>;
}

export interface CodexStreamParams {
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
  onSessionId?: (sessionId: string) => void;
  abortController?: AbortController;
  deps: CodexProviderDeps;
}

/**
 * Stream a walkthrough through an in-process codex subprocess. Mirrors
 * `streamWalkthroughViaOpencodeMCP` in structure (event-queue generator +
 * phase machine + heartbeat) minus the daemon plumbing.
 */
export function streamWalkthroughViaCodexMCP(
  params: CodexStreamParams,
  model?: string,
  settings?: UserSettings,
): AsyncGenerator<WalkthroughStreamEvent> {
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

  let errorEmitted = false;
  let anySummaryEmitted = false;
  let cancelled = false;
  let currentPhase: WalkthroughLifecyclePhase = "connecting";
  let lastPhaseMessage = "Starting up...";
  let lastReasoningPush = 0;
  const PHASE_ORDER: WalkthroughLifecyclePhase[] = [
    "connecting",
    "exploring",
    "analyzing",
    "writing",
    "rating",
    "finishing",
  ];
  const transitionPhase = (next: WalkthroughLifecyclePhase, message: string): void => {
    if (currentPhase === next) return;
    if (PHASE_ORDER.indexOf(next) < PHASE_ORDER.indexOf(currentPhase)) return;
    currentPhase = next;
    lastPhaseMessage = message;
    push({ type: "phase", data: { phase: next, message } });
  };

  const userMessage =
    WALKTHROUGH_MCP_SYSTEM_PROMPT +
    "\n\n---\n\n" +
    buildWalkthroughPrompt(params, undefined, params.continuation);

  const queryTask = (async (): Promise<WalkthroughTokenUsage> => {
    let sessionToken: string | null = null;

    await params.deps.registerActivityNotifier(params.walkthroughId, (event) => {
      if (!queryDone && !errorEmitted && !cancelled) {
        push(event);
      }
    });

    const heartbeatInterval = setInterval(() => {
      if (queryDone || errorEmitted || cancelled) return;
      push({
        type: "phase",
        data: { phase: currentPhase, message: lastPhaseMessage },
      });
    }, WALKTHROUGH_HEARTBEAT_MS);

    try {
      return await withAgentTurn({
        externalAbort: params.abortController,
        hardTimeoutMs: CLI_WALKTHROUGH_TIMEOUT_MS,
        // No daemon to refcount — codex owns its own subprocess.
        jobStarted: async () => {},
        jobEnded: async () => {},
        debugLabel: "walkthrough-codex-mcp",
        onCancel: () => {
          cancelled = true;
        },
        onTimeout: () => {
          cancelled = true;
        },
        run: async (ctx) => {
          // ── 1. Issue session token ───────────────────────────────
          sessionToken = await params.deps.issueSessionToken(params.walkthroughId);
          const mcpUrl = `http://127.0.0.1:${serverEnv.port}/mcp/walkthrough`;
          debug("walkthrough-codex-mcp", `registering MCP ${WALKTHROUGH_MCP_SERVER} → ${mcpUrl}`);

          // ── 2. Construct codex with the HTTP MCP route baked in ───
          const codex = buildCodex(sessionToken, mcpUrl);
          const threadOptions = buildThreadOptions(
            params.worktreePath,
            model,
            settings?.aiThinkingEffort,
          );
          const thread = params.continuation?.codexThreadId
            ? codex.resumeThread(params.continuation.codexThreadId, threadOptions)
            : codex.startThread(threadOptions);

          lastPhaseMessage = "Waiting for model response...";
          push({ type: "phase", data: { phase: "connecting", message: lastPhaseMessage } });

          // ── 3. Drive the stream ──────────────────────────────────
          const emit = (ev: NormalizedAgentEvent): void => {
            if (ev.kind === "text-delta") {
              transitionPhase("exploring", "Reading files and understanding changes...");
              return;
            }
            if (ev.kind === "reasoning-delta") {
              if (ev.data.length > 0) {
                push({ type: "thought", data: { text: ev.data } });
              }
              const now = Date.now();
              if (now - lastReasoningPush >= 30_000) {
                lastReasoningPush = now;
                if (currentPhase === "connecting") {
                  transitionPhase("exploring", "Model is thinking...");
                } else {
                  push({
                    type: "phase",
                    data: { phase: currentPhase, message: "Model is thinking..." },
                  });
                }
              }
              return;
            }
            if (ev.kind !== "tool-call") return;

            if (ev.source === "builtin" && EXPLORATION_TOOLS.has(ev.toolName)) {
              transitionPhase("exploring", "Reading files and understanding changes...");
              push({ type: "exploration", data: buildActivity(ev.toolName, ev.input) });
              return;
            }

            // MCP tool call — drive phase transitions. Codex delivers the bare
            // tool name in `bareName` (e.g. "set_overview"). Constrain to the
            // TOOL_SPECS allowlist so a hallucinated name can't drive a bogus
            // transition.
            const ALLOWED_PHASE_NAMES = new Set(TOOL_SPECS.map((s) => s.name));
            if (!ALLOWED_PHASE_NAMES.has(ev.bareName)) return;
            if (ev.bareName === "set_overview") {
              anySummaryEmitted = true;
              transitionPhase("analyzing", "Forming assessment and risk analysis...");
            } else if (ev.bareName === "add_semantic_step" || ev.bareName === "add_diff_step") {
              transitionPhase("writing", "Building walkthrough...");
            } else if (ev.bareName === "rate_axis") {
              transitionPhase("rating", "Scoring the PR across 9 axes...");
            } else if (ev.bareName === "complete_walkthrough") {
              transitionPhase("finishing", "Wrapping up...");
            } else if (currentPhase === "connecting") {
              transitionPhase("exploring", "Reading files and understanding changes...");
            }
          };

          const { events: codexEvents } = await thread.runStreamed(userMessage, {
            signal: ctx.signal,
          });
          const usage = await walkCodexEvents(codexEvents, emit, {
            onThreadStarted: (threadId) => {
              if (params.onSessionId) params.onSessionId(threadId);
            },
          });

          if (ctx.wasCancelled() || ctx.wasTimeout()) {
            cancelled = true;
            anySummaryEmitted = false;
          } else {
            anySummaryEmitted = anySummaryEmitted && !errorEmitted;
          }

          return (
            usage ?? {
              inputTokens: 0,
              outputTokens: 0,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
            }
          );
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logError("walkthrough-codex-mcp", "queryTask error:", message);
      if (!errorEmitted && !cancelled) {
        errorEmitted = true;
        push({ type: "error", data: { code: "AiGenerationError", message } });
      }
      return {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      };
    } finally {
      clearInterval(heartbeatInterval);
      await params.deps.unregisterActivityNotifier(params.walkthroughId).catch(() => {
        /* ignore */
      });
      if (sessionToken) {
        try {
          await params.deps.clearSessionToken(sessionToken);
        } catch {
          /* ignore */
        }
      }
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

    // DB is authoritative (invariant #1): a resumed run past Phase A skips
    // set_overview, so fall back to the persisted summary before erroring.
    let summaryPersisted = anySummaryEmitted;
    if (!summaryPersisted && !cancelled) {
      try {
        const row = params.db
          .select({ summary: walkthroughsTable.summary })
          .from(walkthroughsTable)
          .where(eq(walkthroughsTable.id, params.walkthroughId))
          .get();
        summaryPersisted = (row?.summary ?? "").length > 0;
      } catch (cause) {
        debug(
          "walkthrough-codex-mcp",
          "summary-persisted DB check failed:",
          cause instanceof Error ? cause.message : String(cause),
        );
      }
    }

    if (summaryPersisted) {
      yield {
        type: "done" as const,
        data: { walkthroughId: params.walkthroughId, tokenUsage },
      };
    } else if (!errorEmitted) {
      debug(
        "walkthrough-codex-mcp",
        "Session ended without producing content — emitting fallback error",
      );
      yield {
        type: "error" as const,
        data: {
          code: "NoSummaryGenerated",
          message:
            "The AI finished without producing a walkthrough. This can happen with complex PRs. Try regenerating.",
        },
      };
    }
  })();
}

// ── codex construction helpers ───────────────────────────────────────────────

function buildCodex(sessionToken: string, mcpUrl: string): Codex {
  const pinned = resolveCliBin("codex");
  return new Codex({
    // Use the pinned binary path when the installer baked one in; else let the
    // SDK resolve `codex` from PATH. Never pass `env` — that would REPLACE
    // process.env and strip the codex CLI's own auth + PATH.
    ...(pinned !== "codex" ? { codexPathOverride: pinned } : {}),
    config: {
      mcp_servers: {
        [WALKTHROUGH_MCP_SERVER]: {
          url: mcpUrl,
          http_headers: { Authorization: `Bearer ${sessionToken}` },
          startup_timeout_sec: 30,
        },
      },
    },
  });
}

function buildThreadOptions(
  worktreePath: string,
  model?: string,
  effort?: UserSettings["aiThinkingEffort"],
) {
  const reasoning = toCodexReasoningEffort(effort);
  return {
    workingDirectory: worktreePath,
    skipGitRepoCheck: true,
    // Walkthrough generation only reads the worktree + writes via MCP; deny
    // filesystem writes and never block on approval prompts.
    sandboxMode: "read-only" as const,
    approvalPolicy: "never" as const,
    ...(model ? { model } : {}),
    ...(reasoning ? { modelReasoningEffort: reasoning } : {}),
  };
}

/**
 * Map Revv's `aiThinkingEffort` vocabulary onto codex's `modelReasoningEffort`.
 * The UI only offers low/medium/high/extra-high for codex, but the Claude-only
 * `ultrathink`/`max` tiers can linger in settings after an agent switch — fold
 * those into the highest codex tier rather than dropping the knob.
 */
function toCodexReasoningEffort(
  effort: UserSettings["aiThinkingEffort"] | undefined,
): "low" | "medium" | "high" | "xhigh" | undefined {
  switch (effort) {
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "extra-high":
    case "max":
    case "ultrathink":
      return "xhigh";
    default:
      return undefined;
  }
}
