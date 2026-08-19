// ── ACP connection pool ──────────────────────────────────────────────────────
//
// One ACP (Agent Client Protocol) agent subprocess per working directory,
// reused across chat turns so resume works and we don't pay subprocess
// cold-start on every message. Talks JSON-RPC over the subprocess stdio via the
// official `@agentclientprotocol/sdk` `ClientSideConnection`.
//
// This is the single transport that replaces the bespoke claude/opencode/codex
// chat drivers: the only per-agent difference is the launch command (see
// presets.ts). The Revv side stays the same — we initialize, open a session
// (handing the agent our HTTP MCP endpoint), prompt, and stream `session/update`
// notifications back out through a per-session listener.
//
// Lifecycle: lazily spawned per cwd, kept warm while turns are in flight, and
// idle-stopped after `IDLE_STOP_MS`. On subprocess exit every session id we
// recorded becomes invalid, so callers must reconcile (the chat route persists
// a fresh id on the next `session/new`).

import {
  type Agent,
  type AvailableCommand,
  type Client,
  ClientSideConnection,
  type ContentBlock,
  type McpServer,
  ndJsonStream,
  PROTOCOL_VERSION,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionModeState,
  type SessionUpdate,
  type StopReason,
} from "@agentclientprotocol/sdk";
import type { AcpAgentId } from "@revv/shared";
import { debug } from "../../logger";
import { resolveUserPath } from "../providers/cli-agent";
import { ensureClaudeConfigDir, resolveClaudeConfigDir } from "./claude-config";
import { type AcpLaunchConfig, resolveAcpProcessLaunchById } from "./presets";

const IDLE_STOP_MS = 5 * 60 * 1000;

/**
 * Select the authentication method to request from an ACP agent. Codex's ACP
 * adapter advertises API-key auth first, but a ChatGPT subscription session is
 * the correct default when it is available. Requesting `api-key` first makes a
 * signed-in desktop Codex installation fail before it can inspect that session.
 */
export function selectAcpAuthMethod(
  agent: AcpAgentId,
  methods: readonly { readonly id: string }[],
): string | undefined {
  if (agent === "codex") {
    const chatGpt = methods.find((method) => method.id === "chat-gpt");
    if (chatGpt) return chatGpt.id;
  }
  return methods[0]?.id;
}

export type AcpSessionUpdate = SessionUpdate;

/** Listener invoked for every `session/update` notification on a session. */
export type AcpUpdateListener = (update: AcpSessionUpdate) => void;

export interface AcpNewSessionResult {
  readonly sessionId: string;
  readonly modes: SessionModeState | null;
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
  /** Open a fresh session, handing the agent the supplied MCP servers. */
  readonly newSession: (mcpServers: McpServer[]) => Promise<AcpNewSessionResult>;
  /** Resume an existing session by id. Returns its mode state (for plan mode). */
  readonly loadSession: (
    sessionId: string,
    mcpServers: McpServer[],
  ) => Promise<SessionModeState | null>;
  readonly setMode: (sessionId: string, modeId: string) => Promise<void>;
  readonly prompt: (sessionId: string, prompt: ContentBlock[]) => Promise<StopReason>;
  readonly cancel: (sessionId: string) => Promise<void>;
  /** Force-stop this pooled ACP subprocess. Next use will spawn a fresh connection. */
  readonly stop: () => void;
  /** Register (or clear, with null) the update listener for a session. */
  readonly setListener: (sessionId: string, listener: AcpUpdateListener | null) => void;
  /** Flag a session as plan-mode so the permission handler refuses mode switches. */
  readonly setPlanMode: (sessionId: string, planMode: boolean) => void;
  /** Bump/drop the in-flight refcount that keeps the subprocess warm. */
  readonly jobStarted: () => void;
  readonly jobEnded: () => void;
}

interface ConnectionEntry {
  readonly key: string;
  readonly agent: AcpAgentId;
  readonly config: AcpLaunchConfig;
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
  loadSessionSupported: boolean;
  httpMcpSupported: boolean;
  promptImage: boolean;
  embeddedContext: boolean;
  refcount: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  alive: boolean;
}

// Keyed by agent + model + thinking-effort + context-window + cwd. Any of those
// changing must not reuse an older ACP subprocess launched under different
// model/effort/context (which are baked into its launch args/env), so they all
// participate in the key.
const pool = new Map<string, Promise<ConnectionEntry>>();

function poolKey(cwd: string, agent: AcpAgentId, config: AcpLaunchConfig): string {
  return [
    agent,
    config.model ?? "",
    config.thinkingEffort ?? "",
    config.contextWindow ?? "",
    cwd,
  ].join("\0");
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
      // Auto-allow everything else — reproduces the existing chat semantics
      // (Claude `bypassPermissions` / codex `approval: never`): no permission
      // prompts mid-stream.
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
  agent: AcpAgentId,
  config: AcpLaunchConfig,
  key: string,
): Promise<ConnectionEntry> {
  // Isolated `CLAUDE_CONFIG_DIR` for claude-code (see `claude-config.ts`) —
  // the SAME resolution the subscription-auth probe (`cli-agent.ts`) and the
  // login PTY (`AgentLogin.ts`) use, since Claude Code's Keychain-backed OAuth
  // storage is scoped per config dir. Seed the directory before the agent
  // process can touch it; a no-op once it's already seeded from a prior spawn.
  const claudeConfigDir = resolveClaudeConfigDir(agent);
  if (claudeConfigDir) ensureClaudeConfigDir(claudeConfigDir);

  const { command, args, env } = resolveAcpProcessLaunchById(
    agent,
    config,
    process.env,
    resolveUserPath(),
    { claudeConfigDir },
  );
  const proc = Bun.spawn([command, ...args], {
    cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    // Per-adapter model/effort/context env (Claude Code) layered over the
    // inherited environment. PATH is widened to the user's login-shell PATH so
    // `npx`/`opencode` resolve even when the server inherited a sanitized PATH
    // (launchd / GUI launch) — matching how availability is detected.
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
    agent,
    config,
    cwd,
    proc,
    connection,
    listeners: new Map(),
    availableCommands: new Map(),
    lastCommands: null,
    planModeSessions: new Set(),
    loadSessionSupported: false,
    httpMcpSupported: false,
    promptImage: false,
    embeddedContext: false,
    refcount: 0,
    idleTimer: null,
    alive: true,
  };
  entryRef = entry;

  // Drain stderr to the debug log so agent crashes are diagnosable.
  void (async () => {
    const reader = proc.stderr.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const text = decoder.decode(chunk.value, { stream: true }).trim();
        if (text) debug("acp-connection", `[stderr] ${text}`);
      }
    } catch {
      /* reader closed on exit */
    }
  })();

  // On subprocess exit, evict the entry and reject any in-flight listeners so
  // the next turn spawns fresh.
  void proc.exited.then((code) => {
    entry.alive = false;
    pool.delete(entry.key);
    // Drop every per-session map so a long-lived connection that churns
    // through many sessions can't leak entries (the listener clear also
    // releases any in-flight notification handlers).
    entry.listeners.clear();
    entry.availableCommands.clear();
    entry.planModeSessions.clear();
    debug("acp-connection", `${entry.agent} agent for ${cwd} exited (code=${code ?? "?"})`);
  });

  const initialize = await connection.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {
      // Advertise NO client fs/terminal: the agent edits + commits natively in
      // its cwd (the spike confirmed claude-agent-acp does this), which keeps
      // proposed-commit detection identical to the existing drivers.
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    },
    clientInfo: { name: "Revv", version: "1.0.0" },
  });

  entry.loadSessionSupported = initialize.agentCapabilities?.loadSession === true;
  entry.httpMcpSupported = initialize.agentCapabilities?.mcpCapabilities?.http === true;
  entry.promptImage = initialize.agentCapabilities?.promptCapabilities?.image === true;
  entry.embeddedContext =
    initialize.agentCapabilities?.promptCapabilities?.embeddedContext === true;

  // Authenticate only if the agent advertises auth methods (claude-agent-acp
  // typically inherits local CLI credentials and needs none).
  const authMethods = initialize.authMethods ?? [];
  const methodId = selectAcpAuthMethod(agent, authMethods);
  if (methodId) {
    await connection.authenticate({ methodId });
  }

  return entry;
}

function scheduleIdleStop(entry: ConnectionEntry): void {
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => {
    if (entry.refcount > 0 || !entry.alive) return;
    debug("acp-connection", `idle-stopping ${entry.agent} agent for ${entry.cwd}`);
    pool.delete(entry.key);
    try {
      entry.proc.kill();
    } catch {
      /* already gone */
    }
  }, IDLE_STOP_MS);
}

function stopEntry(entry: ConnectionEntry): void {
  if (!entry.alive) return;
  entry.alive = false;
  pool.delete(entry.key);
  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }
  entry.listeners.clear();
  entry.availableCommands.clear();
  entry.planModeSessions.clear();
  try {
    entry.proc.kill();
  } catch {
    /* already gone */
  }
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
      // Already harvested (e.g. a prior turn or warm-up) — answer instantly.
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

      // Otherwise wait (bounded) for the `available_commands_update` notification.
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
      const res = await connection.newSession({
        cwd: entry.cwd,
        mcpServers,
      });
      return { sessionId: res.sessionId, modes: res.modes ?? null };
    },
    loadSession: async (sessionId, mcpServers) => {
      const res = await connection.loadSession({
        sessionId,
        cwd: entry.cwd,
        mcpServers,
      });
      return res.modes ?? null;
    },
    setMode: async (sessionId, modeId) => {
      await connection.setSessionMode({ sessionId, modeId });
    },
    prompt: async (sessionId, prompt) => {
      const res = await connection.prompt({ sessionId, prompt });
      return res.stopReason;
    },
    cancel: async (sessionId) => {
      try {
        await connection.cancel({ sessionId });
      } catch (err) {
        debug("acp-connection", "cancel failed:", err instanceof Error ? err.message : String(err));
      }
    },
    stop: () => {
      debug("acp-connection", `force-stopping ${entry.agent} agent for ${entry.cwd}`);
      stopEntry(entry);
    },
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
      if (entry.refcount === 0) scheduleIdleStop(entry);
    },
  };
}

/**
 * Get (or lazily spawn) the ACP agent connection for a working directory.
 * Concurrent callers for the same cwd share one subprocess.
 */
export async function getAcpConnection(
  cwd: string,
  agent: AcpAgentId,
  config: AcpLaunchConfig = {},
): Promise<AcpConnectionHandle> {
  const key = poolKey(cwd, agent, config);
  let pending = pool.get(key);
  if (!pending) {
    pending = spawnConnection(cwd, agent, config, key).catch((err) => {
      pool.delete(key);
      throw err;
    });
    pool.set(key, pending);
  }
  const entry = await pending;
  if (!entry.alive) {
    // Raced with an exit between resolve and use — retry once with a fresh spawn.
    pool.delete(key);
    return getAcpConnection(cwd, agent, config);
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
  agent: AcpAgentId,
  config: AcpLaunchConfig = {},
): Promise<AcpConnectionHandle | null> {
  const pending = pool.get(poolKey(cwd, agent, config));
  if (!pending) return null;
  let entry: ConnectionEntry;
  try {
    entry = await pending;
  } catch {
    // The pooled spawn rejected — treat as no warm connection.
    return null;
  }
  if (!entry.alive) return null;
  return makeHandle(entry);
}

/** Best-effort teardown of all pooled agents (process shutdown). */
export function stopAllAcpConnections(): void {
  for (const [cwd, pending] of pool) {
    pool.delete(cwd);
    void pending
      .then((entry) => {
        stopEntry(entry);
      })
      .catch(() => {
        /* never spawned */
      });
  }
}
