// The one way an agent turn runs: connect, open (or reload) a session with
// Revv's MCP server, set its mode, prompt, and stream `session/update`s to the
// caller, under the turn's deadlines. Chat, walkthrough, recap, stack brief and
// the one-shot prompts are thin users of it; nothing else touches the
// connection pool.
//
// Deadlines are about liveness, not length: a turn dies when the agent has
// produced nothing for `idleMs` (rearmed by every session update and every
// `activity.note()`), and `ceilingMs` is only a backstop far above any healthy
// run. Ending a turn early cancels its session, never the shared subprocess;
// an agent that ignores the cancel gets its connection retired instead.

import type { ContentBlock, McpServer, SessionUpdate, StopReason } from "@agentclientprotocol/sdk";
import { getAcpAgent } from "@revv/shared";
import { serverEnv } from "../../config";
import { debug } from "../../logger";
import { graftedSpan, publishTraceAnchor } from "../../observability/span-graft";
import { decodeAcpSessionUpdate, makeAcpDecodeState } from "../agent-stream/acp-decoders";
import { type AcpConnectionHandle, getAcpConnection, peekAcpConnection } from "./acp-connection";
import { type AgentTurnFailure, agentTurnFailure } from "./agent-failure";
import type { AgentLaunch } from "./agent-launch";
import { isAgentLaunchable } from "./launch";
import { ensurePackageRunnerDir } from "./package-runner-dir";
import { findPlanModeId, modeToExitPlan } from "./session-config";

export interface TurnDeadlines {
  /** Abort after this long without agent activity. Omit for a short one-shot. */
  readonly idleMs?: number;
  /** Absolute backstop, counted from the start of the turn (connect included). */
  readonly ceilingMs: number;
}

/**
 * Walkthrough, recap and stack-brief turns. A large PR takes tens of minutes,
 * and killing a working agent throws its work away, so the ceiling sits far
 * above any healthy run and the idle deadline does the real work.
 */
export const JOB_TURN = {
  idleMs: 5 * 60 * 1000,
  ceilingMs: 45 * 60 * 1000,
} as const satisfies TurnDeadlines;

/**
 * Chat turns. One message may ask the agent to fix every issue with a commit
 * each, and its test suites and builds print nothing until they exit (one tool
 * call, then silence), so both deadlines are longer than a job's.
 */
export const CHAT_TURN = {
  idleMs: 15 * 60 * 1000,
  ceilingMs: 2 * 60 * 60 * 1000,
} as const satisfies TurnDeadlines;

/** How long a cancelled prompt gets to settle before its connection is retired. */
const CANCEL_GRACE_MS = 1_500;

/**
 * Liveness a caller pokes when the agent proves it is working outside the ACP
 * stream (an MCP call authenticated with the job's token). Never poked by a
 * synthetic heartbeat, or the idle deadline could never fire.
 */
export interface ActivityBeacon {
  readonly note: () => void;
  readonly onNote: (listener: () => void) => () => void;
}

/**
 * How a job tells its running turn that the work is done (its journal check
 * passed), so the turn ends as `settled` instead of waiting for the agent to
 * wind down. Unlike a cancel, it never retires the shared connection.
 */
export interface TurnSettle {
  readonly settle: () => void;
  readonly settled: () => boolean;
  readonly whenSettled: Promise<void>;
}

export function makeTurnSettle(): TurnSettle {
  let done = false;
  let resolve: () => void = () => {};
  const whenSettled = new Promise<void>((r) => {
    resolve = r;
  });
  return {
    settle: () => {
      done = true;
      resolve();
    },
    settled: () => done,
    whenSettled,
  };
}

export function makeActivityBeacon(): ActivityBeacon {
  const listeners = new Set<() => void>();
  return {
    note: (): void => {
      for (const listener of listeners) listener();
    },
    onNote: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    },
  };
}

/** Revv's HTTP MCP endpoint handed to the agent for this turn. */
export interface TurnMcpServer {
  readonly route: string;
  readonly name: string;
  readonly token: string;
  /** Fail when the agent can't speak HTTP MCP; otherwise the turn runs without it. */
  readonly required: boolean;
}

export interface OpenedSession {
  readonly sessionId: string;
  /** A new session: it has neither the system prompt nor the conversation yet. */
  readonly fresh: boolean;
  /** A stale model setting the agent's catalog lacks; the session runs on its default. */
  readonly unavailableModel?: string;
  readonly promptImage: boolean;
  readonly embeddedContext: boolean;
}

export interface AcpTurnRequest {
  /** For debug logs. */
  readonly label: string;
  readonly launch: AgentLaunch;
  readonly cwd: string;
  readonly mcp?: TurnMcpServer;
  /** Reload this session when the agent can; a fresh one otherwise. */
  readonly resumeSessionId?: string | null;
  /** Put the session in its read-only plan mode, or out of it. Omit to leave its mode. */
  readonly mode?: "plan" | "default";
  /** Awaited before prompting, e.g. to persist a fresh session id. */
  readonly onSessionOpened?: (session: OpenedSession) => Promise<void> | void;
  /** The prompt, built once the session is known to be fresh or resumed. */
  readonly prompt: (session: OpenedSession) => ContentBlock[];
  readonly onUpdate: (update: SessionUpdate) => void;
  readonly deadlines: TurnDeadlines;
  /** Extra liveness for the idle deadline, beyond the session's own updates. */
  readonly activity?: ActivityBeacon;
  readonly signal?: AbortSignal;
  readonly settle?: TurnSettle;
  /**
   * Files `Acp.connect` / `Acp.newSession` / `Acp.prompt` spans under the job's
   * trace anchor `key`, tagged with its id under `attribute` (`walkthrough_id`,
   * `recapId`, …).
   */
  readonly trace?: { readonly key: string; readonly attribute: string };
}

/** How a turn ended. `runAcpTurn` never throws: every way out is one of these. */
export type AcpTurnOutcome =
  | { readonly kind: "stopped"; readonly stopReason: StopReason }
  /** The caller's {@link TurnSettle} fired: its work is done. */
  | { readonly kind: "settled" }
  | { readonly kind: "cancelled"; readonly reason: string }
  | { readonly kind: "timeout"; readonly reason: string }
  | { readonly kind: "failed"; readonly failure: AgentTurnFailure }
  /** The agent's launch command doesn't resolve on this machine. */
  | { readonly kind: "not_configured"; readonly message: string };

type TurnEnd = Extract<AcpTurnOutcome, { readonly kind: "settled" | "cancelled" | "timeout" }>;

class AgentNotLaunchable extends Error {}

/** The default connect: a pooled agent, after checking a new one could start at all. */
async function connectLaunchable(cwd: string, launch: AgentLaunch): Promise<AcpConnectionHandle> {
  if (!isAgentLaunchable(launch.agent)) {
    throw new AgentNotLaunchable(
      `The configured agent ('${launch.agent}') is not available on this machine.`,
    );
  }
  return getAcpConnection(cwd, launch);
}

function humanize(ms: number): string {
  return ms < 60_000 ? `${Math.round(ms / 1_000)} seconds` : `${Math.round(ms / 60_000)} minutes`;
}

/** The turn's deadlines, caller signal and settle, folded into one end. */
function armTurn(req: AcpTurnRequest, activity: ActivityBeacon) {
  let ended: TurnEnd | null = null;
  let onEnd: (() => void) | null = null;
  const ended$ = new Promise<void>((resolve) => {
    onEnd = resolve;
  });
  const finish = (next: TurnEnd): void => {
    if (ended) return;
    ended = next;
    debug(req.label, `${next.kind === "settled" ? "settled" : next.reason} — ending the turn`);
    onEnd?.();
  };
  const end = (kind: "cancelled" | "timeout", reason: string): void => finish({ kind, reason });

  const ceiling = setTimeout(
    () => end("timeout", `Agent turn timed out after ${humanize(req.deadlines.ceilingMs)}`),
    req.deadlines.ceilingMs,
  );
  const { idleMs } = req.deadlines;
  let idle: ReturnType<typeof setTimeout> | undefined;
  const rearmIdle = (): void => {
    clearTimeout(idle);
    if (idleMs === undefined || ended) return;
    idle = setTimeout(
      () => end("timeout", `Agent stopped responding — no activity for ${humanize(idleMs)}`),
      idleMs,
    );
  };
  const unsubscribe = activity.onNote(rearmIdle);
  rearmIdle();

  const onAbort = (): void => {
    const reason = req.signal?.reason;
    end("cancelled", reason instanceof Error ? reason.message : "Agent turn cancelled");
  };
  if (req.signal?.aborted) onAbort();
  else req.signal?.addEventListener("abort", onAbort, { once: true });
  if (req.settle?.settled()) finish({ kind: "settled" });
  else void req.settle?.whenSettled.then(() => finish({ kind: "settled" }));

  return {
    ended: () => ended,
    whenEnded: ended$,
    dispose: (): void => {
      clearTimeout(ceiling);
      clearTimeout(idle);
      unsubscribe();
      req.signal?.removeEventListener("abort", onAbort);
    },
  };
}

async function traced<T>(
  trace: AcpTurnRequest["trace"],
  name: string,
  attributes: Record<string, string | number>,
  run: () => Promise<T>,
): Promise<T> {
  if (trace === undefined) return run();
  const span = graftedSpan(trace.key, name, { attributes });
  try {
    return await run();
  } catch (err) {
    span.fail(err);
    throw err;
  } finally {
    span.end();
  }
}

/**
 * Run one agent turn and resolve with how it ended. A failure carries its kind
 * and the sign-in / Keychain guidance.
 */
export async function runAcpTurn(
  req: AcpTurnRequest,
  connect: (cwd: string, launch: AgentLaunch) => Promise<AcpConnectionHandle> = connectLaunchable,
): Promise<AcpTurnOutcome> {
  const { launch, trace } = req;
  const activity = req.activity ?? makeActivityBeacon();
  const turn = armTurn(req, activity);
  const spanAttrs = {
    acp_agent: launch.agent,
    ...(trace ? { [trace.attribute]: trace.key } : {}),
  };

  const held: { handle: AcpConnectionHandle | null; session: OpenedSession | null } = {
    handle: null,
    session: null,
  };
  let released = false;
  // Drops the listener and the connection reference exactly once, whether the
  // turn finished or the caller stopped waiting for an agent ignoring a cancel.
  const release = (): void => {
    const { handle, session } = held;
    if (released || !handle) return;
    released = true;
    if (session) {
      handle.setListener(session.sessionId, null);
      handle.setPlanMode(session.sessionId, false);
    }
    handle.jobEnded();
  };

  const body = async (): Promise<StopReason | null> => {
    const h = await traced(trace, "Acp.connect", spanAttrs, () => connect(req.cwd, launch));
    held.handle = h;
    h.jobStarted();
    if (turn.ended() || released) {
      release();
      return null;
    }

    const mcpServers: McpServer[] = [];
    if (req.mcp) {
      if (h.httpMcpSupported) {
        mcpServers.push({
          type: "http",
          name: req.mcp.name,
          url: `http://127.0.0.1:${serverEnv.port}${req.mcp.route}`,
          headers: [{ name: "Authorization", value: `Bearer ${req.mcp.token}` }],
        });
      } else if (req.mcp.required) {
        throw new Error(
          `The ${getAcpAgent(launch.agent).label} agent doesn't support HTTP MCP, which this needs.`,
        );
      } else {
        debug(req.label, "agent does not advertise HTTP MCP — running without Revv's tools");
      }
    }

    const opened = await traced(trace, "Acp.newSession", spanAttrs, async () => {
      if (req.resumeSessionId && h.loadSessionSupported) {
        try {
          const state = await h.loadSession(req.resumeSessionId, mcpServers);
          return { sessionId: req.resumeSessionId, fresh: false, state };
        } catch (err) {
          debug(
            req.label,
            "session/load failed; opening a fresh session:",
            err instanceof Error ? err.message : String(err),
          );
        }
      }
      const created = await h.newSession(mcpServers);
      return { sessionId: created.sessionId, fresh: true, state: created };
    });
    if (released) return null;
    const { sessionId } = opened;
    const session: OpenedSession = {
      sessionId,
      fresh: opened.fresh,
      ...(opened.state.unavailableModel ? { unavailableModel: opened.state.unavailableModel } : {}),
      promptImage: h.promptImage,
      embeddedContext: h.embeddedContext,
    };
    held.session = session;
    h.setListener(sessionId, (update) => {
      activity.note();
      if (!released) req.onUpdate(update);
    });
    if (turn.ended()) return null;

    if (req.mode === "plan") {
      const planModeId = findPlanModeId(opened.state.modes);
      if (!planModeId) {
        throw new Error("This agent has no plan mode. Turn plan mode off to send the message.");
      }
      await h.setMode(sessionId, planModeId);
      h.setPlanMode(sessionId, true);
    } else if (req.mode === "default") {
      const exitModeId = modeToExitPlan(opened.state.modes);
      if (exitModeId) await h.setMode(sessionId, exitModeId);
    }

    await req.onSessionOpened?.(session);
    if (turn.ended()) return null;

    const blocks = req.prompt(session);
    const promptAttrs = {
      ...spanAttrs,
      prompt_chars: blocks.reduce((n, b) => n + (b.type === "text" ? b.text.length : 0), 0),
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.name": launch.agent,
      "gen_ai.conversation.id": sessionId,
      model: launch.model,
      "gen_ai.request.model": launch.model,
    };
    if (trace === undefined) return h.prompt(sessionId, blocks);
    // Re-anchored so everything the turn provokes (the agent's own tool calls,
    // its MCP writes arriving over HTTP) nests inside the prompt span.
    const span = graftedSpan(trace.key, "Acp.prompt", { attributes: promptAttrs });
    const restoreAnchor = publishTraceAnchor(trace.key, span.anchor);
    try {
      const stopReason = await h.prompt(sessionId, blocks);
      span.setAttributes({ stop_reason: String(stopReason) });
      return stopReason;
    } catch (err) {
      span.fail(err);
      throw err;
    } finally {
      restoreAnchor();
      span.end();
    }
  };

  let bodySettled = false;
  const running = body().finally(() => {
    bodySettled = true;
  });
  try {
    const stopReason = await Promise.race([running, turn.whenEnded.then(() => null)]);
    if (stopReason !== null) return { kind: "stopped", stopReason };
    const ending = turn.ended() ?? { kind: "cancelled" as const, reason: "Agent turn cancelled" };
    const h = held.handle;
    const sid = held.session?.sessionId;
    if (h && sid) {
      void h.cancel(sid);
      // The connection is shared: only retire it when the agent ignores the
      // cancel, and never for a turn whose work is done.
      if (ending.kind !== "settled") {
        setTimeout(() => {
          if (!bodySettled) h.retire();
        }, CANCEL_GRACE_MS);
      }
    }
    // A failure that only surfaces after the turn ended is noise from the teardown.
    void running.catch(() => {});
    return ending;
  } catch (err) {
    const early = turn.ended();
    if (early) return early;
    if (err instanceof AgentNotLaunchable) return { kind: "not_configured", message: err.message };
    return { kind: "failed", failure: agentTurnFailure(launch.agent, err) };
  } finally {
    turn.dispose();
    release();
  }
}

/** The agent's visible text, or why there is none (with sign-in guidance when it applies). */
export type PromptOnceResult =
  | { readonly kind: "answered"; readonly text: string }
  | { readonly kind: "failed"; readonly error: string; readonly guidance: string | null };

/**
 * A tool-less, one-off prompt (suggestions, stack headlines, the agent check)
 * on a fresh session. Runs in a Revv-owned directory with no project in it, so
 * every such prompt shares one warm agent per launch whatever repo it is about.
 */
export async function promptOnce(input: {
  readonly label: string;
  readonly launch: AgentLaunch;
  readonly text: string;
  readonly ceilingMs: number;
}): Promise<PromptOnceResult> {
  let collected = "";
  const decodeState = makeAcpDecodeState();
  const outcome = await runAcpTurn({
    label: input.label,
    launch: input.launch,
    cwd: ensurePackageRunnerDir() ?? process.cwd(),
    prompt: () => [{ type: "text", text: input.text }],
    onUpdate: (update) => {
      for (const ev of decodeAcpSessionUpdate(update, decodeState)) {
        if (ev.kind === "text-delta") collected += ev.data;
      }
    },
    deadlines: { ceilingMs: input.ceilingMs },
  });
  switch (outcome.kind) {
    case "stopped":
    case "settled":
      return { kind: "answered", text: collected };
    case "cancelled":
    case "timeout":
      return { kind: "failed", error: outcome.reason, guidance: null };
    case "not_configured":
      return { kind: "failed", error: outcome.message, guidance: null };
    case "failed":
      return {
        kind: "failed",
        error: outcome.failure.agentMessage,
        guidance: outcome.failure.guidance,
      };
  }
}

export interface AgentSessionContext {
  readonly commands: ReadonlyArray<{ readonly name: string; readonly description: string }>;
  readonly promptImage: boolean;
  readonly embeddedContext: boolean;
}

/**
 * What the chat composer needs from the agent for `cwd`: its capabilities and
 * slash commands. `warm` starts the agent (and harvests its commands through
 * a throwaway session) when it isn't running; otherwise this only reads a
 * running one and answers `null` without one.
 */
export async function agentSessionContext(input: {
  readonly launch: AgentLaunch;
  readonly cwd: string;
  readonly warm: boolean;
  /** The chat's agent session, whose cached commands are read first. */
  readonly sessionId: string | null;
}): Promise<AgentSessionContext | null> {
  const handle = input.warm
    ? await getAcpConnection(input.cwd, input.launch)
    : await peekAcpConnection(input.cwd, input.launch);
  if (!handle) return null;
  let raw = input.sessionId ? handle.getAvailableCommands(input.sessionId) : [];
  if (input.warm) {
    // Held for the harvest, so a warm-up nobody chats on still idle-stops.
    handle.jobStarted();
    try {
      if (raw.length === 0) raw = await handle.listAvailableCommands();
    } finally {
      handle.jobEnded();
    }
  }
  return {
    commands: raw.map((command) => ({ name: command.name, description: command.description })),
    promptImage: handle.promptImage,
    embeddedContext: handle.embeddedContext,
  };
}
