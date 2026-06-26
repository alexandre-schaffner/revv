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
import { type AcpLaunchConfig, resolveAcpLaunchById } from "./presets";

const IDLE_STOP_MS = 5 * 60 * 1000;

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
  readonly planModeSessions: Set<string>;
  loadSessionSupported: boolean;
  httpMcpSupported: boolean;
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
      const listener = entry().listeners.get(params.sessionId);
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
  const { command, args, env } = resolveAcpLaunchById(agent, config);
  const proc = Bun.spawn([command, ...args], {
    cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    // Per-adapter model/effort/context env (Claude Code) layered over the
    // inherited environment. PATH is widened to the user's login-shell PATH so
    // `npx`/`opencode` resolve even when the server inherited a sanitized PATH
    // (launchd / GUI launch) — matching how availability is detected.
    env: { ...process.env, ...env, PATH: resolveUserPath() },
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
    planModeSessions: new Set(),
    loadSessionSupported: false,
    httpMcpSupported: false,
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
    entry.listeners.clear();
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

  // Authenticate only if the agent advertises auth methods (claude-agent-acp
  // typically inherits local CLI credentials and needs none).
  const authMethods = initialize.authMethods ?? [];
  if (authMethods.length > 0) {
    const methodId = authMethods[0]?.id;
    if (methodId) {
      await connection.authenticate({ methodId });
    }
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

function makeHandle(entry: ConnectionEntry): AcpConnectionHandle {
  const { connection } = entry;
  return {
    loadSessionSupported: entry.loadSessionSupported,
    httpMcpSupported: entry.httpMcpSupported,
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

/** Best-effort teardown of all pooled agents (process shutdown). */
export function stopAllAcpConnections(): void {
  for (const [cwd, pending] of pool) {
    pool.delete(cwd);
    void pending
      .then((entry) => {
        entry.alive = false;
        try {
          entry.proc.kill();
        } catch {
          /* already gone */
        }
      })
      .catch(() => {
        /* never spawned */
      });
  }
}
