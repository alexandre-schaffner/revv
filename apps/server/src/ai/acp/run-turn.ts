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
import { toAgentTurnError } from "./agent-failure";
import type { AgentLaunch } from "./agent-launch";
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
  /** Files `Acp.connect` / `Acp.newSession` / `Acp.prompt` spans under this trace anchor key. */
  readonly traceKey?: string;
}

export type AcpTurnEnd =
  | { readonly kind: "stopped"; readonly stopReason: StopReason }
  | { readonly kind: "cancelled"; readonly reason: string }
  | { readonly kind: "timeout"; readonly reason: string };

export interface AcpTurnResult {
  readonly end: AcpTurnEnd;
  /** Null when the turn ended before a session opened. */
  readonly session: OpenedSession | null;
}

function humanize(ms: number): string {
  return ms < 60_000 ? `${Math.round(ms / 1_000)} seconds` : `${Math.round(ms / 60_000)} minutes`;
}

/** The turn's deadlines and caller signal, folded into one abort. */
function armTurn(req: AcpTurnRequest, activity: ActivityBeacon) {
  let ended: { readonly kind: "cancelled" | "timeout"; readonly reason: string } | null = null;
  let onEnd: (() => void) | null = null;
  const ended$ = new Promise<void>((resolve) => {
    onEnd = resolve;
  });
  const end = (kind: "cancelled" | "timeout", reason: string): void => {
    if (ended) return;
    ended = { kind, reason };
    debug(req.label, `${reason} — ending the turn`);
    onEnd?.();
  };

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
  key: string | undefined,
  name: string,
  attributes: Record<string, string | number>,
  run: () => Promise<T>,
): Promise<T> {
  if (key === undefined) return run();
  const span = graftedSpan(key, name, { attributes });
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
 * Run one agent turn. Resolves with how it ended; a cancel or a deadline is an
 * end, not an error. Any other failure rejects with an `AgentTurnError` that
 * carries its kind and the sign-in / Keychain guidance.
 */
export async function runAcpTurn(
  req: AcpTurnRequest,
  connect: (cwd: string, launch: AgentLaunch) => Promise<AcpConnectionHandle> = getAcpConnection,
): Promise<AcpTurnResult> {
  const { launch } = req;
  const activity = req.activity ?? makeActivityBeacon();
  const turn = armTurn(req, activity);
  const spanAttrs = {
    acp_agent: launch.agent,
    ...(req.traceKey ? { walkthrough_id: req.traceKey } : {}),
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
    const h = await traced(req.traceKey, "Acp.connect", spanAttrs, () => connect(req.cwd, launch));
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

    const opened = await traced(req.traceKey, "Acp.newSession", spanAttrs, async () => {
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
    if (req.traceKey === undefined) return h.prompt(sessionId, blocks);
    // Re-anchored so everything the turn provokes (the agent's own tool calls,
    // its MCP writes arriving over HTTP) nests inside the prompt span.
    const span = graftedSpan(req.traceKey, "Acp.prompt", { attributes: promptAttrs });
    const restoreAnchor = publishTraceAnchor(req.traceKey, span.anchor);
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
    if (stopReason !== null) {
      return { end: { kind: "stopped", stopReason }, session: held.session };
    }
    const ending = turn.ended() ?? { kind: "cancelled" as const, reason: "Agent turn cancelled" };
    const h = held.handle;
    const sid = held.session?.sessionId;
    if (h && sid) {
      void h.cancel(sid);
      // The connection is shared: only retire it when the agent ignores the cancel.
      setTimeout(() => {
        if (!bodySettled) h.retire();
      }, CANCEL_GRACE_MS);
    }
    // A failure that only surfaces after the turn ended is noise from the teardown.
    void running.catch(() => {});
    return { end: ending, session: held.session };
  } catch (err) {
    const early = turn.ended();
    if (early) return { end: early, session: held.session };
    throw toAgentTurnError(launch.agent, err);
  } finally {
    turn.dispose();
    release();
  }
}

/**
 * A tool-less, one-off prompt (suggestions, stack headlines, the agent check)
 * on a fresh session, returning the agent's visible text. Runs in a
 * Revv-owned directory with no project in it, so every such prompt shares one
 * warm agent per launch whatever repo it is about.
 */
export async function promptOnce(input: {
  readonly label: string;
  readonly launch: AgentLaunch;
  readonly text: string;
  readonly ceilingMs: number;
}): Promise<string> {
  let collected = "";
  const decodeState = makeAcpDecodeState();
  const { end } = await runAcpTurn({
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
  if (end.kind !== "stopped") throw new Error(end.reason);
  return collected;
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
