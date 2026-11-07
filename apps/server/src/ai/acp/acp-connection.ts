// One ACP (Agent Client Protocol) agent subprocess per working directory,
// reused across chat turns so resume works and we don't pay subprocess
// cold-start on every message. Talks JSON-RPC over the subprocess stdio via the
// official `@agentclientprotocol/sdk` `ClientSideConnection`.
//
// Only the turn runner (`run-turn.ts`) uses this pool: per-agent launch
// details come from the adapters (`agents/`, through `launch.ts`).
//
// Lifecycle: lazily spawned per (cwd, agent, model, effort), kept warm while
// turns hold a reference, and idle-stopped `IDLE_STOP_MS` after the last one
// ends. A connection whose agent ignored a cancel is retired: no new turn gets
// it, and it is stopped once the turns still on it end. On subprocess exit
// every session id it issued is gone; the runner falls back to a fresh session
// when a resume id no longer loads.

import {
  type Agent,
  type AvailableCommand,
  type Client,
  ClientSideConnection,
  type ContentBlock,
  type McpServer,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionModeState,
  type SessionUpdate,
  type StopReason,
} from "@agentclientprotocol/sdk";
import { type AcpAgentId, getAcpAgent } from "@revv/shared";
import { debug, logError } from "../../logger";
import type { AgentLaunch } from "./agent-launch";
import { agentAdapter } from "./agents";
import { resolveAgentProcess } from "./launch";
import { ensurePackageRunnerDir } from "./package-runner-dir";
import {
  planModelSelection,
  resolveSessionModes,
  type SessionConfigSource,
} from "./session-config";

const IDLE_STOP_MS = 5 * 60 * 1000;
const STDERR_TAIL_CHARS = 2000;
const ERROR_DATA_CHARS = 500;
const STARTUP_EXIT_GRACE_MS = 1000;
const STARTUP_STDERR_LINES = 6;
/**
 * Bound on spawn → `initialize` → `authenticate`. Covers a cold package-runner
 * install of the adapter; a spawn stuck past it is killed so the pool doesn't
 * hand the same hung promise to every later turn.
 */
const CONNECT_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * A JSON-RPC error's message with its `details` folded in. An agent that throws
 * a plain error is answered by the ACP SDK as `{ message: "Internal error",
 * data: { details } }`, so the message alone names nothing. Other structured
 * data (an adapter's `errorKind`) is left for the caller to interpret.
 */
export function acpErrorMessage(message: string, data: unknown): string {
  const detail =
    typeof data === "string"
      ? data
      : data !== null && typeof data === "object" && "details" in data
        ? String(data.details ?? "")
        : "";
  const trimmed = detail.trim();
  if (trimmed === "" || message.includes(trimmed)) return message;
  const clipped =
    trimmed.length > ERROR_DATA_CHARS ? `${trimmed.slice(0, ERROR_DATA_CHARS)}…` : trimmed;
  return `${message}: ${clipped}`;
}

async function withErrorDetail<T>(request: Promise<T>): Promise<T> {
  try {
    return await request;
  } catch (err) {
    if (!(err instanceof RequestError)) throw err;
    const message = acpErrorMessage(err.message, err.data);
    if (message === err.message) throw err;
    throw new RequestError(err.code, message, err.data);
  }
}

/**
 * The error for an agent process that exited before the ACP handshake, carrying
 * the last lines it printed. Deliberately free of "connection closed", so it
 * isn't mistaken for a login or Keychain problem.
 */
export function agentStartupFailureMessage(
  agent: AcpAgentId,
  exitCode: number,
  stderr: string,
): string {
  const lines = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-STARTUP_STDERR_LINES);
  const head = `The ${getAcpAgent(agent).label} agent exited before it started (exit code ${exitCode}).`;
  return lines.length > 0 ? `${head}\n\n${lines.join("\n")}` : head;
}

/**
 * Codex silently refuses to start an MCP server whose name contains anything
 * outside `[A-Za-z0-9_-]`: it emits an internal `mcp__<name>__startup` tool call
 * that never connects, our HTTP route is never hit, and the turn runs with none
 * of our tools — the agent just reports them "unavailable". The chat server is
 * named after the prId (`<repoId>:<prNumber>`), whose colon trips this.
 * Normalize here, at the one point every ACP caller funnels through, so no
 * adapter can be handed an unsafe name.
 * Nothing reads the name back, so rewriting it is invisible to callers.
 */
export function sanitizeMcpServerName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, "-");
}

function sanitizeMcpServers(servers: McpServer[]): McpServer[] {
  return servers.map((server) => {
    const name = sanitizeMcpServerName(server.name);
    return name === server.name ? server : { ...server, name };
  });
}

export type AcpSessionUpdate = SessionUpdate;

export type AcpUpdateListener = (update: AcpSessionUpdate) => void;

export interface AcpSessionState {
  readonly modes: SessionModeState | null;
  /**
   * The per-session model the agent's catalog lacks — a stale setting — which
   * left the session on the agent's default model. Callers that face the user
   * surface it, since the reply won't come from the model the picker shows.
   */
  readonly unavailableModel?: string;
}

export interface AcpNewSessionResult extends AcpSessionState {
  readonly sessionId: string;
}

export interface AcpConnectionHandle {
  /** Capabilities advertised by the agent at `initialize`. */
  readonly loadSessionSupported: boolean;
  readonly httpMcpSupported: boolean;
  readonly promptImage: boolean;
  readonly embeddedContext: boolean;
  readonly getAvailableCommands: (sessionId: string) => readonly AvailableCommand[];
  /**
   * Harvest the agent's available slash commands without running a turn. Returns
   * the connection-level cache if already known (populated by any prior session,
   * including real turns); otherwise opens a throwaway session purely to receive
   * the agent's `available_commands_update`. The throwaway session is NEVER
   * persisted as a chat session id — the first real turn still opens its own
   * fresh `session/new` (preserving the system-prompt / walkthrough prepend).
   */
  readonly listAvailableCommands: (timeoutMs?: number) => Promise<readonly AvailableCommand[]>;
  readonly newSession: (mcpServers: McpServer[]) => Promise<AcpNewSessionResult>;
  /**
   * Resume an existing session by id. Returns its mode state (for plan mode).
   * Like `newSession`, applies the launch's per-session model, if any.
   */
  readonly loadSession: (sessionId: string, mcpServers: McpServer[]) => Promise<AcpSessionState>;
  readonly setMode: (sessionId: string, modeId: string) => Promise<void>;
  readonly prompt: (sessionId: string, prompt: ContentBlock[]) => Promise<StopReason>;
  readonly cancel: (sessionId: string) => Promise<void>;
  /**
   * Take this connection out of the pool: later turns spawn a fresh one, and
   * this one stops as soon as no turn holds it.
   */
  readonly retire: () => void;
  readonly setListener: (sessionId: string, listener: AcpUpdateListener | null) => void;
  /** Flag a session as plan-mode so the permission handler refuses mode switches. */
  readonly setPlanMode: (sessionId: string, planMode: boolean) => void;
  /** Bump/drop the in-flight refcount that keeps the subprocess warm. */
  readonly jobStarted: () => void;
  readonly jobEnded: () => void;
}

interface ConnectionEntry {
  readonly key: string;
  /** Identifies this spawn's pool slot, so a retired entry never evicts its successor. */
  readonly slot: symbol;
  readonly agent: AcpAgentId;
  readonly cwd: string;
  readonly proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  readonly connection: ClientSideConnection;
  readonly listeners: Map<string, AcpUpdateListener>;
  readonly availableCommands: Map<string, AvailableCommand[]>;
  // Connection-level snapshot of the most recent `available_commands_update`
  // from ANY session on this subprocess. Slash commands are project-scoped (the
  // pool is keyed by cwd), so once any session reports them they're valid for
  // the whole connection — lets `listAvailableCommands` answer without opening a
  // session after the first turn, and survives churn through session ids.
  lastCommands: AvailableCommand[] | null;
  readonly planModeSessions: Set<string>;
  readonly selections: SessionSelections;
  loadSessionSupported: boolean;
  httpMcpSupported: boolean;
  promptImage: boolean;
  embeddedContext: boolean;
  refcount: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  alive: boolean;
  retired: boolean;
}

// Keyed by agent + model + thinking-effort + cwd. A change to any of them must
// not reuse an older ACP subprocess launched under a different model/effort:
// both ride in its launch env (opencode 1 reads the model only from there, even
// though opencode 2 takes it per session), so they all participate in the key.
const pool = new Map<string, { readonly slot: symbol; readonly ready: Promise<ConnectionEntry> }>();

/** Every spawned subprocess, pooled or retired, until it exits. */
const live = new Set<ConnectionEntry>();

function forget(entry: ConnectionEntry): void {
  if (pool.get(entry.key)?.slot === entry.slot) pool.delete(entry.key);
}

function poolKey(cwd: string, launch: AgentLaunch): string {
  return [launch.agent, launch.model, launch.thinkingEffort ?? "", cwd].join("\0");
}

function buildClient(entry: () => ConnectionEntry): Client {
  return {
    sessionUpdate: async (params): Promise<void> => {
      const current = entry();
      if (params.update.sessionUpdate === "available_commands_update") {
        current.availableCommands.set(params.sessionId, params.update.availableCommands);
        current.lastCommands = params.update.availableCommands;
      }
      const listener = current.listeners.get(params.sessionId);
      if (listener) listener(params.update);
    },
    requestPermission: async (
      params: RequestPermissionRequest,
    ): Promise<RequestPermissionResponse> => {
      const { sessionId, toolCall, options } = params;
      const planMode = entry().planModeSessions.has(sessionId);
      // Defensive plan-mode carve-out: never auto-approve a switch out of the
      // read-only mode while the user is reviewing a plan. The agent's own
      // read-only mode is the primary guard; this backstops it.
      if (planMode && toolCall.kind === "switch_mode") {
        const reject =
          options.find((o) => o.kind === "reject_once") ??
          options.find((o) => o.kind.startsWith("reject"));
        return reject
          ? { outcome: { outcome: "selected", optionId: reject.optionId } }
          : { outcome: { outcome: "cancelled" } };
      }
      // Auto-allow everything else: no permission prompts mid-stream (the
      // equivalent of Claude `bypassPermissions` / Codex `approval: never`).
      const allow =
        options.find((o) => o.kind === "allow_once") ??
        options.find((o) => o.kind.startsWith("allow"));
      return allow
        ? { outcome: { outcome: "selected", optionId: allow.optionId } }
        : { outcome: { outcome: "cancelled" } };
    },
  };
}

async function spawnConnection(
  cwd: string,
  launch: AgentLaunch,
  key: string,
  slot: symbol,
): Promise<ConnectionEntry> {
  const { agent } = launch;
  const { command, args, env, sessionModel, viaPackageRunner } = resolveAgentProcess(agent, launch);
  const proc = Bun.spawn([command, ...args], {
    // A package runner must not run inside the reviewed repo: npm reads that
    // repo's `package.json` and exits on one it can't parse (see
    // `package-runner-dir.ts`). The worktree still reaches the agent as the
    // session `cwd`.
    cwd: (viaPackageRunner ? ensurePackageRunnerDir() : null) ?? cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env,
  });

  // Bun's `proc.stdin` is a FileSink; wrap it as a WritableStream<Uint8Array>
  // for ndJsonStream. `proc.stdout` is already a ReadableStream<Uint8Array>.
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      proc.stdin.write(chunk);
      proc.stdin.flush();
    },
    close() {
      proc.stdin.end();
    },
  });
  const stream = ndJsonStream(writable, proc.stdout);

  let entryRef: ConnectionEntry | null = null;
  const connection = new ClientSideConnection(
    (_agent: Agent) => buildClient(() => entryRef as ConnectionEntry),
    stream,
  );

  const entry: ConnectionEntry = {
    key,
    slot,
    agent,
    cwd,
    proc,
    connection,
    listeners: new Map(),
    availableCommands: new Map(),
    lastCommands: null,
    planModeSessions: new Set(),
    selections: createSessionSelections(connection, sessionModel, agent),
    loadSessionSupported: false,
    httpMcpSupported: false,
    promptImage: false,
    embeddedContext: false,
    refcount: 0,
    idleTimer: null,
    alive: true,
    retired: false,
  };
  entryRef = entry;
  live.add(entry);

  // Drain stderr to the debug log so agent crashes are diagnosable, keeping a
  // short tail for the startup-failure message below.
  let stderrTail = "";
  const stderrDrained = (async () => {
    const reader = proc.stderr.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const text = decoder.decode(chunk.value, { stream: true });
        stderrTail = (stderrTail + text).slice(-STDERR_TAIL_CHARS);
        if (text.trim()) debug("acp-connection", `[stderr] ${text.trim()}`);
      }
    } catch {
      /* reader closed on exit */
    }
  })();

  void proc.exited.then((code) => {
    entry.alive = false;
    live.delete(entry);
    forget(entry);
    clearSessionState(entry);
    debug("acp-connection", `${entry.agent} agent for ${cwd} exited (code=${code ?? "?"})`);
  });

  let connectTimer: ReturnType<typeof setTimeout> | undefined;
  const connectDeadline = new Promise<never>((_, reject) => {
    connectTimer = setTimeout(() => {
      proc.kill();
      reject(
        new Error(
          `The ${getAcpAgent(agent).label} agent didn't start within ${CONNECT_TIMEOUT_MS / 60_000} minutes.`,
        ),
      );
    }, CONNECT_TIMEOUT_MS);
  });
  try {
    return await Promise.race([handshake(entry, stderrDrained, () => stderrTail), connectDeadline]);
  } finally {
    clearTimeout(connectTimer);
  }
}

async function handshake(
  entry: ConnectionEntry,
  stderrDrained: Promise<void>,
  stderrTail: () => string,
): Promise<ConnectionEntry> {
  const { connection, proc, agent } = entry;
  let initialize: Awaited<ReturnType<typeof connection.initialize>>;
  try {
    initialize = await connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        // Advertise NO client fs/terminal: the agent edits and commits natively
        // in its cwd, which proposed-commit detection relies on.
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: "Revv", version: "1.0.0" },
    });
  } catch (err) {
    // An agent that dies before answering `initialize` (a package runner that
    // can't install it, a bad flag) surfaces from the SDK as a bare "ACP
    // connection closed", which reads as an auth failure. Name the exit and
    // what the process printed instead.
    const exitCode = await Promise.race([
      proc.exited,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), STARTUP_EXIT_GRACE_MS)),
    ]);
    if (exitCode === null) {
      proc.kill();
      throw err;
    }
    await stderrDrained;
    throw new Error(agentStartupFailureMessage(agent, exitCode, stderrTail()));
  }

  entry.loadSessionSupported = initialize.agentCapabilities?.loadSession === true;
  entry.httpMcpSupported = initialize.agentCapabilities?.mcpCapabilities?.http === true;
  entry.promptImage = initialize.agentCapabilities?.promptCapabilities?.image === true;
  entry.embeddedContext =
    initialize.agentCapabilities?.promptCapabilities?.embeddedContext === true;

  // Authenticate only if the agent advertises auth methods (claude-agent-acp
  // typically inherits local CLI credentials and needs none).
  const methodId = agentAdapter(agent).authMethod(initialize.authMethods ?? []);
  if (methodId) {
    await connection.authenticate({ methodId });
  }

  return entry;
}

function clearSessionState(entry: ConnectionEntry): void {
  entry.listeners.clear();
  entry.availableCommands.clear();
  entry.planModeSessions.clear();
  entry.selections.clear();
}

function scheduleIdleStop(entry: ConnectionEntry): void {
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => {
    if (entry.refcount > 0 || !entry.alive) return;
    debug("acp-connection", `idle-stopping ${entry.agent} agent for ${entry.cwd}`);
    forget(entry);
    try {
      entry.proc.kill();
    } catch {
      /* already gone */
    }
  }, IDLE_STOP_MS);
}

function retireEntry(entry: ConnectionEntry): void {
  if (entry.retired || !entry.alive) return;
  entry.retired = true;
  forget(entry);
  debug("acp-connection", `retiring ${entry.agent} agent for ${entry.cwd}`);
  if (entry.refcount === 0) stopEntry(entry);
}

function stopEntry(entry: ConnectionEntry): void {
  if (!entry.alive) return;
  entry.alive = false;
  forget(entry);
  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }
  clearSessionState(entry);
  try {
    entry.proc.kill();
  } catch {
    /* already gone */
  }
}

export type SessionSelectionConnection = Pick<
  ClientSideConnection,
  "setSessionConfigOption" | "setSessionMode"
>;

export interface SessionSelections {
  /** Apply the per-session model to a just-opened/loaded session and return its state. */
  readonly adopt: (sessionId: string, res: SessionConfigSource) => Promise<AcpSessionState>;
  /** Switch a session's mode through whichever channel it advertised its modes on. */
  readonly setMode: (sessionId: string, modeId: string) => Promise<void>;
  readonly clear: () => void;
}

/**
 * Per-connection routing of a session's model and mode over ACP. A model
 * missing from the session's catalog is a stale setting (the picker lists a
 * subset of opencode's ACP catalog): like a stale id in a static catalog (see
 * `resolveGenerationModel`), it leaves the session on the agent's default
 * rather than failing the turn, and is reported as `unavailableModel`.
 */
export function createSessionSelections(
  connection: SessionSelectionConnection,
  sessionModel: string | undefined,
  agent: AcpAgentId,
): SessionSelections {
  // Sessions whose modes are a `mode`-category config option (opencode, which
  // advertises no `modes`), switched through that option's id rather than
  // `session/set_mode`.
  const modeConfigIds = new Map<string, string>();

  /** Apply the model; returns it when the session's catalog lacks it. */
  const applyModel = async (
    sessionId: string,
    configOptions: SessionConfigSource["configOptions"],
  ): Promise<string | undefined> => {
    if (!sessionModel) return undefined;
    const selection = planModelSelection(configOptions, sessionModel);
    switch (selection.kind) {
      case "switch":
        await connection.setSessionConfigOption({
          sessionId,
          configId: selection.configId,
          value: sessionModel,
        });
        return undefined;
      case "unavailable":
        logError("acp-connection", `${agent} has no model "${sessionModel}"; using its default`);
        return sessionModel;
      case "none":
        // Not a known fallback: an agent without the option may still have
        // taken the model at launch (opencode 1's config env).
        logError("acp-connection", `${agent} offers no model option; ignoring "${sessionModel}"`);
        return undefined;
      case "current":
        return undefined;
    }
  };

  const setMode = async (sessionId: string, modeId: string): Promise<void> => {
    const configId = modeConfigIds.get(sessionId);
    if (configId) {
      await connection.setSessionConfigOption({ sessionId, configId, value: modeId });
    } else {
      await connection.setSessionMode({ sessionId, modeId });
    }
  };

  const { sessionMode } = getAcpAgent(agent);

  return {
    adopt: async (sessionId, res) => {
      const unavailableModel = await applyModel(sessionId, res.configOptions);
      const { modes: advertised, modeConfigId } = resolveSessionModes(res);
      if (modeConfigId) modeConfigIds.set(sessionId, modeConfigId);
      else modeConfigIds.delete(sessionId);
      // A fresh session starts in the agent's default mode and a reloaded one in
      // its last mode, plan included, so both are moved to Revv's.
      let modes = advertised;
      if (
        sessionMode &&
        modes &&
        modes.currentModeId !== sessionMode &&
        modes.availableModes.some((mode) => mode.id === sessionMode)
      ) {
        await setMode(sessionId, sessionMode);
        modes = { ...modes, currentModeId: sessionMode };
      }
      return { modes, ...(unavailableModel ? { unavailableModel } : {}) };
    },
    setMode,
    clear: () => modeConfigIds.clear(),
  };
}

function makeHandle(entry: ConnectionEntry): AcpConnectionHandle {
  const { connection } = entry;
  return {
    loadSessionSupported: entry.loadSessionSupported,
    httpMcpSupported: entry.httpMcpSupported,
    promptImage: entry.promptImage,
    embeddedContext: entry.embeddedContext,
    getAvailableCommands: (sessionId) => entry.availableCommands.get(sessionId) ?? [],
    listAvailableCommands: async (timeoutMs = 8_000) => {
      if (entry.lastCommands) return entry.lastCommands;

      // Open a throwaway session (no MCP servers needed — commands are the
      // agent's own, not tool-derived). Its id is intentionally NOT reported to
      // any caller, so it never becomes a persisted chat session id.
      let sessionId: string;
      try {
        const res = await connection.newSession({ cwd: entry.cwd, mcpServers: [] });
        sessionId = res.sessionId;
      } catch (err) {
        debug(
          "acp-connection",
          "listAvailableCommands newSession failed:",
          err instanceof Error ? err.message : String(err),
        );
        return entry.lastCommands ?? [];
      }

      // Commands may already have streamed in during `newSession`.
      const immediate = entry.availableCommands.get(sessionId);
      if (immediate && immediate.length > 0) return immediate;

      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          entry.listeners.delete(sessionId);
          resolve();
        };
        const timer = setTimeout(finish, timeoutMs);
        entry.listeners.set(sessionId, (update) => {
          if (update.sessionUpdate === "available_commands_update") finish();
        });
        // Close the race: the update may have landed between the post-newSession
        // check above and this listener registration.
        if ((entry.availableCommands.get(sessionId)?.length ?? 0) > 0) finish();
      });
      return entry.lastCommands ?? entry.availableCommands.get(sessionId) ?? [];
    },
    newSession: async (mcpServers) => {
      const res = await withErrorDetail(
        connection.newSession({ cwd: entry.cwd, mcpServers: sanitizeMcpServers(mcpServers) }),
      );
      return { sessionId: res.sessionId, ...(await entry.selections.adopt(res.sessionId, res)) };
    },
    loadSession: async (sessionId, mcpServers) => {
      const res = await withErrorDetail(
        connection.loadSession({
          sessionId,
          cwd: entry.cwd,
          mcpServers: sanitizeMcpServers(mcpServers),
        }),
      );
      return entry.selections.adopt(sessionId, res);
    },
    setMode: (sessionId, modeId) => entry.selections.setMode(sessionId, modeId),
    prompt: async (sessionId, prompt) => {
      const res = await withErrorDetail(connection.prompt({ sessionId, prompt }));
      return res.stopReason;
    },
    cancel: async (sessionId) => {
      try {
        await connection.cancel({ sessionId });
      } catch (err) {
        debug("acp-connection", "cancel failed:", err instanceof Error ? err.message : String(err));
      }
    },
    retire: () => retireEntry(entry),
    setListener: (sessionId, listener) => {
      if (listener) entry.listeners.set(sessionId, listener);
      else entry.listeners.delete(sessionId);
    },
    setPlanMode: (sessionId, planMode) => {
      if (planMode) entry.planModeSessions.add(sessionId);
      else entry.planModeSessions.delete(sessionId);
    },
    jobStarted: () => {
      entry.refcount += 1;
      if (entry.idleTimer) {
        clearTimeout(entry.idleTimer);
        entry.idleTimer = null;
      }
    },
    jobEnded: () => {
      entry.refcount = Math.max(0, entry.refcount - 1);
      if (entry.refcount > 0) return;
      if (entry.retired) stopEntry(entry);
      else scheduleIdleStop(entry);
    },
  };
}

function pooledOrSpawned(cwd: string, launch: AgentLaunch): Promise<ConnectionEntry> {
  const key = poolKey(cwd, launch);
  const pooled = pool.get(key);
  if (pooled) return pooled.ready;
  const slot = Symbol(key);
  const ready = spawnConnection(cwd, launch, key, slot).catch((err) => {
    if (pool.get(key)?.slot === slot) pool.delete(key);
    throw err;
  });
  pool.set(key, { slot, ready });
  return ready;
}

/**
 * Get (or lazily spawn) the ACP agent connection for a working directory and
 * launch. Concurrent callers for the same key share one subprocess.
 */
export async function getAcpConnection(
  cwd: string,
  launch: AgentLaunch,
): Promise<AcpConnectionHandle> {
  let entry = await pooledOrSpawned(cwd, launch);
  if (!entry.alive) {
    // It exited between spawn and use: one fresh spawn, whose failure is final.
    forget(entry);
    entry = await pooledOrSpawned(cwd, launch);
    if (!entry.alive) throw new Error(`The ${getAcpAgent(launch.agent).label} agent exited.`);
  }
  return makeHandle(entry);
}

/**
 * Return a handle to an ALREADY-WARM pooled connection for `cwd`, or null if
 * none is pooled (or it has since exited). Unlike {@link getAcpConnection},
 * this never spawns a subprocess. Read-only callers that only want
 * capabilities/cached commands (the session-context menu fetch, which fires on
 * every PR selection) use this so they never pay a cold-start just to read.
 */
export async function peekAcpConnection(
  cwd: string,
  launch: AgentLaunch,
): Promise<AcpConnectionHandle | null> {
  const pooled = pool.get(poolKey(cwd, launch));
  if (!pooled) return null;
  let entry: ConnectionEntry;
  try {
    entry = await pooled.ready;
  } catch {
    return null;
  }
  if (!entry.alive) return null;
  return makeHandle(entry);
}

/** Best-effort teardown of every agent subprocess (process shutdown). */
export function stopAllAcpConnections(): void {
  for (const [key, pooled] of pool) {
    pool.delete(key);
    void pooled.ready.then(stopEntry).catch(() => {
      /* never spawned */
    });
  }
  for (const entry of live) stopEntry(entry);
}
