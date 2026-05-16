// ── OpencodeSupervisor ─────────────────────────────────────────────────────
//
// Lifecycle manager for the `opencode serve` HTTP daemon. Replaces the
// previous "spawn one `opencode run` subprocess per walkthrough job + stdio
// MCP server" model with a single long-lived daemon that Revv reuses across
// jobs. Per doctrine invariant #14 (agent-daemon lifecycle):
//
//   • Lazy-start: we only spin up `opencode serve` when the active agent is
//     'opencode' AND at least one job needs it (jobStarted() / jobEnded()
//     drive this). If the user is on Claude, the daemon never runs.
//   • Idle cooldown: after the last job ends, a 30s timer fires stopIfIdle()
//     to shed the process. If a new job arrives in the cooldown window the
//     timer cancels and the process stays up.
//   • Ephemeral credentials: OPENCODE_SERVER_PASSWORD is regenerated on every
//     start and lives only in this process's memory. The daemon binds to a
//     fresh OS-assigned port (--port 0) that we parse from its stdout. Never
//     persisted anywhere.
//   • Crash-loop cap: auto-restart up to 3 times inside a 60s window. After
//     that the service enters `unhealthy=true` and refuses to spawn again
//     until a successful manual `ensureRunning()` call (which resets the
//     counter).
//   • Settings-change stop: subscribes to SettingsService changes so moving
//     away from 'opencode' hard-stops the daemon (we observe the change by
//     polling settings on each jobStarted() — Settings doesn't yet expose a
//     change stream). The stop is a best-effort kill; credentials are wiped.
//
// Transport: `@opencode-ai/sdk` typed client. The supervisor builds one
// OpencodeClient per daemon spawn (with basic-auth header baked in via the
// SDK's `headers` option) and exposes it through `client()`. Providers call
// SDK methods directly — there is no hand-rolled HTTP wrapper. The SDK's
// default fetch wrapper sets `req.timeout = false` for Bun, which is what
// prevents Bun's 5-minute idle timeout from killing 10+ minute agent turns
// (the load-bearing reason the previous SDK migration was reverted before
// v1.14.50 — see commits 83087451 / d9c78713).

import { resolve } from "node:path";
import { createOpencodeClient, type OpencodeClient, type Part } from "@opencode-ai/sdk";
import { and, eq } from "drizzle-orm";
import { Context, Effect, Layer, Ref } from "effect";
import { resolveCliBin } from "../ai/providers/cli-agent";
import { disableBunTimeout } from "../constants";
import type { Db } from "../db/index";
import { kvCache } from "../db/schema/index";
import {
  type AiError,
  AiGenerationError,
  OpencodeNotSelectedError,
  OpencodeUnhealthyError,
} from "../domain/errors";
import { withDb } from "../effects/with-db";
import { debug, logError } from "../logger";
import { DbService } from "./Db";
import { SettingsService } from "./Settings";

// ── Public types ─────────────────────────────────────────────────────────────

export interface OpencodeEndpoint {
  readonly port: number;
  readonly hostname: string;
  readonly password: string;
}

export type OpencodeError = AiError;

// Re-export the SDK's typed Part union so the rest of the codebase can import
// it from one place without depending on the SDK's deep subpaths directly.
export type { OpencodeClient, Part };

// ── Service tag ──────────────────────────────────────────────────────────────

export class OpencodeSupervisor extends Context.Tag("OpencodeSupervisor")<
  OpencodeSupervisor,
  {
    /**
     * Ensure the daemon is running and reachable. Lazy-starts on first
     * call; subsequent calls return the same endpoint until the daemon
     * stops. Crash-looping daemons return an error; call `stopNow()` +
     * `ensureRunning()` to attempt a recovery.
     */
    readonly ensureRunning: () => Effect.Effect<OpencodeEndpoint, OpencodeError>;
    /**
     * Decrement job count and schedule a stop if idle (30s cooldown).
     * Idempotent — safe to call even with no active job.
     */
    readonly stopIfIdle: () => Effect.Effect<void>;
    /** Immediately kill the daemon. */
    readonly stopNow: () => Effect.Effect<void>;
    /** Current SDK client. Null when daemon is not running. */
    readonly client: () => Effect.Effect<OpencodeClient | null>;
    readonly isHealthy: () => Effect.Effect<boolean>;
    /** Signal a job has started — bumps refcount, cancels any idle timer. */
    readonly jobStarted: () => Effect.Effect<void>;
    /** Signal a job has ended — may schedule cooldown stop. */
    readonly jobEnded: () => Effect.Effect<void>;
    /**
     * Register a handler that fires whenever a running daemon process
     * exits — crash, idle stop, settings-change kill, all of them.
     * Returns an unsubscribe function so callers can clean up
     * registrations across hot reloads. Used by AiService to invalidate
     * stored opencode session ids in `chat_sessions` (per invariant #14:
     * daemon-bound state is ephemeral).
     */
    readonly onDaemonExit: (handler: () => void) => () => void;
    /**
     * List the agents available on the running daemon. Cached at startup
     * via `GET /agent`; re-probed on each daemon restart since
     * `.opencode/opencode.toml` overrides can change between sessions.
     * Returns an empty array when no daemon is running.
     */
    readonly listAgents: () => Effect.Effect<readonly string[]>;
    /**
     * Cheap check whether an agent by `name` is available. Reads the
     * cached agent list. Returns `false` when the daemon isn't running
     * (the chat-opencode driver should ensureDaemon() first).
     */
    readonly hasAgent: (name: string) => Effect.Effect<boolean>;
  }
>() {}

// ── Internal state ───────────────────────────────────────────────────────────

interface RunningState {
  readonly port: number;
  readonly hostname: string;
  readonly password: string;
  readonly proc: ReturnType<typeof Bun.spawn>;
  readonly client: OpencodeClient;
}

interface SupervisorState {
  readonly running: RunningState | null;
  readonly activeJobCount: number;
  readonly idleTimer: ReturnType<typeof setTimeout> | null;
  readonly restartTimestamps: readonly number[];
  readonly unhealthy: boolean;
  readonly lastSelectedAgent: string | null;
  /**
   * Names of agents the running daemon exposes via `GET /agent`. Probed
   * once per daemon start; null while not yet probed (or no daemon).
   */
  readonly agentNames: readonly string[] | null;
}

const INITIAL_STATE: SupervisorState = {
  running: null,
  activeJobCount: 0,
  idleTimer: null,
  restartTimestamps: [],
  unhealthy: false,
  lastSelectedAgent: null,
  agentNames: null,
};

const IDLE_COOLDOWN_MS = 30_000;
const CRASH_LOOP_WINDOW_MS = 60_000;
const CRASH_LOOP_MAX = 3;

const SUPERVISOR_NS = "supervisor";
const CRASH_LOG_KEY = "crash_log";

// Load crash timestamps that were persisted before the last server restart.
// Filters out entries older than the rolling window so stale crashes from
// a previous server run don't incorrectly pollute the current window.
function loadPersistedCrashTimestamps(db: Db): readonly number[] {
  try {
    const row = db
      .select({ valueJson: kvCache.valueJson })
      .from(kvCache)
      .where(and(eq(kvCache.ns, SUPERVISOR_NS), eq(kvCache.key, CRASH_LOG_KEY)))
      .get();
    if (!row) return [];
    const raw = JSON.parse(row.valueJson) as unknown;
    if (!Array.isArray(raw)) return [];
    const now = Date.now();
    return (raw as number[]).filter((t) => typeof t === "number" && now - t < CRASH_LOOP_WINDOW_MS);
  } catch {
    return [];
  }
}

function persistCrashTimestamps(db: Db, stamps: readonly number[]): void {
  try {
    if (stamps.length === 0) {
      db.delete(kvCache)
        .where(and(eq(kvCache.ns, SUPERVISOR_NS), eq(kvCache.key, CRASH_LOG_KEY)))
        .run();
      return;
    }
    const now = new Date().toISOString();
    db.insert(kvCache)
      .values({ ns: SUPERVISOR_NS, key: CRASH_LOG_KEY, valueJson: JSON.stringify(stamps), fetchedAt: now })
      .onConflictDoUpdate({
        target: [kvCache.ns, kvCache.key],
        set: { valueJson: JSON.stringify(stamps), fetchedAt: now },
      })
      .run();
  } catch (err) {
    logError(
      "opencode-supervisor",
      "failed to persist crash log:",
      err instanceof Error ? err.message : String(err),
    );
  }
}
const HEALTH_POLL_INTERVAL_MS = 250;
const HEALTH_POLL_TIMEOUT_MS = 15_000;

function randomPassword(): string {
  // 32 bytes of cryptographically strong randomness, base64url-encoded.
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  let binary = "";
  for (const b of buf) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function basicAuthHeader(password: string): string {
  return `Basic ${btoa(`opencode:${password}`)}`;
}

// ── SDK client construction ──────────────────────────────────────────────────

function buildSdkClient(hostname: string, port: number, password: string): OpencodeClient {
  const baseUrl = `http://${hostname}:${port}`;
  const authHeader = basicAuthHeader(password);
  // Belt-and-suspenders custom fetch: the SDK's default already sets
  // `req.timeout = false` for Bun, but providing our own makes the intent
  // explicit and documents the load-bearing reason — Bun's 5-minute idle
  // timeout otherwise kills long-running `session.prompt` calls (the agent
  // loop runs 10+ minutes on complex PRs) and prematurely terminates the
  // global event SSE subscription. This was the exact failure mode that
  // caused the alpha-era SDK migration (commit 83087451) to be reverted in
  // d9c78713 — keep it documented here so the trap isn't re-walked.
  const customFetch: (req: Request) => ReturnType<typeof fetch> = (req) => {
    disableBunTimeout(req);
    return fetch(req);
  };
  // Note: `throwOnError` is intentionally NOT set at the client level.
  // Method-level type inference for each generated SDK call defaults to
  // `ThrowOnError extends false`, so setting it at construction would make
  // runtime and types disagree — runtime would throw, types would still
  // expose an `error` branch. Callers that want throw-on-error pass
  // `throwOnError: true` per call (where the type narrows correctly to
  // `{ data, request, response }`); callers that want to inspect the 404
  // race on abort omit it and branch on `error`.
  return createOpencodeClient({
    baseUrl,
    fetch: customFetch,
    headers: { Authorization: authHeader },
  });
}

// ── Live implementation ──────────────────────────────────────────────────────

export const OpencodeSupervisorLive = Layer.effect(
  OpencodeSupervisor,
  Effect.gen(function* () {
    const { db } = yield* DbService;
    const settingsService = yield* SettingsService;
    // Restore crash timestamps that survived the last server restart.
    // If we're already at the crash-loop threshold, start unhealthy so
    // a persistently broken daemon can't get 3 free attempts on every restart.
    const restoredTimestamps = loadPersistedCrashTimestamps(db);
    const stateRef = yield* Ref.make<SupervisorState>({
      ...INITIAL_STATE,
      restartTimestamps: restoredTimestamps,
      unhealthy: restoredTimestamps.length >= CRASH_LOOP_MAX,
    });
    // Semaphore(1) serializes ensureRunning — prevents two concurrent fibers
    // from both seeing running=null and spawning duplicate daemons.
    const startLock = yield* Effect.makeSemaphore(1);

    // Lives outside Effect state — handlers are plain JS callbacks (no
    // effectful semantics) and we want to fire them synchronously inside
    // `proc.exited.then()` without round-tripping through Ref.
    const exitHandlers = new Set<() => void>();
    const fireExitHandlers = (): void => {
      for (const h of exitHandlers) {
        try {
          h();
        } catch (err) {
          logError(
            "opencode-supervisor",
            "daemon-exit handler threw:",
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    };

    const resolveAgentName = (): Effect.Effect<string> =>
      withDb(db, settingsService.getSettings()).pipe(
        Effect.map((s) => s.aiAgent ?? "opencode"),
        Effect.catchAll(() => Effect.succeed("opencode")),
      );

    const clearIdleTimer = (): Effect.Effect<void> =>
      Ref.update(stateRef, (s) => {
        if (s.idleTimer !== null) {
          try {
            clearTimeout(s.idleTimer);
          } catch {
            /* ignore */
          }
        }
        return { ...s, idleTimer: null };
      });

    const killRunning = (running: RunningState): void => {
      try {
        running.proc.kill();
      } catch {
        /* already dead */
      }
    };

    const waitForHealth = async (
      hostname: string,
      port: number,
      password: string,
      timeoutMs: number = HEALTH_POLL_TIMEOUT_MS,
    ): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      const authHeader = basicAuthHeader(password);
      while (Date.now() < deadline) {
        try {
          const res = await fetch(`http://${hostname}:${port}/`, {
            headers: { Authorization: authHeader },
          });
          if (res.ok || res.status === 404) {
            // 404 is fine — it just means there's no root route, but
            // the server is up and responding.
            return;
          }
        } catch {
          /* connection refused — daemon still starting */
        }
        await new Promise((r) => setTimeout(r, HEALTH_POLL_INTERVAL_MS));
      }
      throw new Error(`opencode serve did not become healthy within ${timeoutMs}ms`);
    };

    const parsePortFromLog = (chunk: string): number | null => {
      // opencode logs its bound address when it starts. We match several
      // known formats. The latest opencode emits exactly:
      //   "opencode server listening on http://127.0.0.1:<port>"
      // which is matched by both pattern [2] and pattern [3] below.
      const patterns = [
        /listening on [^\s:]+:(\d+)/i,
        /listening on port (\d+)/i,
        /opencode server listening on .*:(\d+)/i, // matches latest format
        /http:\/\/[^\s:]+:(\d+)/i, // also matches latest format
      ];
      for (const p of patterns) {
        const m = p.exec(chunk);
        if (m?.[1]) {
          const n = Number.parseInt(m[1], 10);
          if (!Number.isNaN(n) && n > 0) return n;
        }
      }
      return null;
    };

    const probeAgents = async (client: OpencodeClient): Promise<readonly string[]> => {
      try {
        const result = await client.app.agents({ throwOnError: true });
        const list = result.data;
        if (!Array.isArray(list)) return [];
        const names: string[] = [];
        for (const entry of list) {
          if (typeof entry.name === "string" && entry.name.length > 0) {
            names.push(entry.name);
          }
        }
        return names;
      } catch (err) {
        debug(
          "opencode-supervisor",
          "listAgents failed:",
          err instanceof Error ? err.message : String(err),
        );
        return [];
      }
    };

    const spawnDaemon = async (): Promise<RunningState> => {
      const password = randomPassword();
      const hostname = "127.0.0.1";
      const bin = resolveCliBin("opencode");
      debug("opencode-supervisor", "spawning", bin, "serve");
      // Spawn with cwd set to the monorepo root so opencode's project
      // detection finds .git there instead of reporting "No .git found at
      // apps/server". import.meta.dir = apps/server/src/services → ../../../..
      const monorepoRoot = resolve(import.meta.dir, "../../../..");
      const proc = Bun.spawn([bin, "serve", "--port", "0", "--hostname", hostname], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        cwd: monorepoRoot,
        env: {
          ...process.env,
          OPENCODE_SERVER_PASSWORD: password,
        },
      });

      // Parse the port out of stdout (opencode prints it at start). Also
      // tee stderr for debug logs so operators can see any daemon noise.
      const stdoutLines: string[] = [];
      const stderrLines: string[] = [];

      let resolvedPort: number | null = null;
      const portWaiters: Array<(p: number) => void> = [];

      const readStream = (
        stream: ReadableStream<Uint8Array>,
        sink: string[],
        tag: string,
        captureFn: (line: string) => void,
      ): void => {
        void (async () => {
          const decoder = new TextDecoder();
          let buf = "";
          try {
            for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
              buf += decoder.decode(chunk, { stream: true });
              let nl = buf.indexOf("\n");
              while (nl !== -1) {
                const line = buf.slice(0, nl);
                buf = buf.slice(nl + 1);
                if (line.trim()) {
                  sink.push(line);
                  debug("opencode-supervisor", tag, line.trim().slice(0, 300));
                  captureFn(line);
                }
                nl = buf.indexOf("\n");
              }
            }
            if (buf.trim()) {
              sink.push(buf);
              captureFn(buf);
            }
          } catch (err) {
            debug(
              "opencode-supervisor",
              `${tag} read error:`,
              err instanceof Error ? err.message : String(err),
            );
          }
        })();
      };

      readStream(
        proc.stdout as unknown as ReadableStream<Uint8Array>,
        stdoutLines,
        "stdout",
        (line) => {
          if (resolvedPort === null) {
            const p = parsePortFromLog(line);
            if (p !== null) {
              resolvedPort = p;
              for (const w of portWaiters) w(p);
              portWaiters.length = 0;
            }
          }
        },
      );
      readStream(
        proc.stderr as unknown as ReadableStream<Uint8Array>,
        stderrLines,
        "stderr",
        (line) => {
          if (resolvedPort === null) {
            const p = parsePortFromLog(line);
            if (p !== null) {
              resolvedPort = p;
              for (const w of portWaiters) w(p);
              portWaiters.length = 0;
            }
          }
        },
      );

      // Wait for the port to show up in the log stream. Abort on timeout
      // or if the process exits early.
      const portPromise = new Promise<number>((resolvePort, reject) => {
        const timeout = setTimeout(() => {
          reject(
            new Error(`opencode serve did not log its port within ${HEALTH_POLL_TIMEOUT_MS}ms`),
          );
        }, HEALTH_POLL_TIMEOUT_MS);
        portWaiters.push((p) => {
          clearTimeout(timeout);
          resolvePort(p);
        });
        proc.exited.then((code) => {
          if (resolvedPort === null) {
            clearTimeout(timeout);
            const tail = [...stdoutLines, ...stderrLines].slice(-5).join("\n");
            reject(
              new Error(
                `opencode serve exited with code ${code} before logging its port. Last output:\n${tail}`,
              ),
            );
          }
        });
      });

      const port = await portPromise;
      // Port appeared in the daemon's log output — the HTTP server is already
      // bound. Do a single quick health check (2s) as a sanity gate rather than
      // the full 15s polling loop.
      await waitForHealth(hostname, port, password, 5_000);

      const client = buildSdkClient(hostname, port, password);
      const running: RunningState = { hostname, port, password, proc, client };

      // Wire exit handler so we know when the daemon dies unexpectedly and
      // can update state (and consider auto-restart).
      void proc.exited.then((code) => {
        // Fire registered exit handlers eagerly — every daemon death
        // (crash, idle stop, explicit stop, settings change) leaves
        // any cached session ids referring to a process that's gone.
        // Consumers (AiService → ChatSessionService) invalidate stored
        // state here. Fires exactly once per spawn since proc.exited
        // resolves once. Outside the `s.running !== running` guard on
        // purpose: the guard exists to skip duplicate ref-clears when
        // `stopNow()`/`stopIfIdle()` already cleared state, but exit
        // handlers must still run in those paths.
        fireExitHandlers();
        void Effect.runPromise(
          Effect.gen(function* () {
            const s = yield* Ref.get(stateRef);
            if (s.running !== running) return; // already replaced
            debug("opencode-supervisor", `daemon exited (code=${code}) — clearing running state`);
            yield* Ref.update(stateRef, (st) => ({
              ...st,
              running: null,
            }));
            if (s.activeJobCount > 0 && !s.unhealthy) {
              // Unexpected crash while work is in flight — record a
              // restart timestamp for crash-loop accounting. The next
              // ensureRunning() call performs the actual respawn.
              const now = Date.now();
              const recent = s.restartTimestamps.filter((t) => now - t < CRASH_LOOP_WINDOW_MS);
              const nextCount = recent.length + 1;
              const nextStamps = [...recent, now];
              const unhealthy = nextCount >= CRASH_LOOP_MAX;
              yield* Ref.update(stateRef, (st) => ({
                ...st,
                restartTimestamps: nextStamps,
                unhealthy,
              }));
              persistCrashTimestamps(db, nextStamps);
              if (unhealthy) {
                logError(
                  "opencode-supervisor",
                  `crash loop detected (${nextCount} restarts in <${CRASH_LOOP_WINDOW_MS}ms) — marking unhealthy`,
                );
              }
            }
          }),
        );
      });

      return running;
    };

    const ensureRunning = (): Effect.Effect<OpencodeEndpoint, OpencodeError> =>
      startLock.withPermits(1)(
        Effect.gen(function* () {
          // Cancel any pending idle stop — someone wants the daemon.
          yield* clearIdleTimer();

          const snapshot = yield* Ref.get(stateRef);

          // Detect agent-change and stop if we're no longer 'opencode'.
          const agent = yield* resolveAgentName();
          if (agent !== "opencode") {
            yield* stopNow();
            return yield* Effect.fail(new OpencodeNotSelectedError({ selectedAgent: agent }));
          }

          if (snapshot.unhealthy) {
            return yield* Effect.fail(
              new OpencodeUnhealthyError(),
            );
          }

          if (snapshot.running) {
            return {
              port: snapshot.running.port,
              hostname: snapshot.running.hostname,
              password: snapshot.running.password,
            };
          }

          const running = yield* Effect.tryPromise({
            try: () => spawnDaemon(),
            catch: (err) => {
              debug(
                "opencode-supervisor",
                "spawn failed:",
                err instanceof Error ? err.message : String(err),
              );
              return new AiGenerationError({
                cause: err,
                message: err instanceof Error ? err.message : String(err),
              });
            },
          });

          yield* Ref.update(stateRef, (s) => ({
            ...s,
            running,
            lastSelectedAgent: agent,
            // Successful start resets the crash-loop counter.
            restartTimestamps: [],
            unhealthy: false,
            // Reset cached agent list — probe again below.
            agentNames: null,
          }));
          // Clear persisted crash log — daemon is healthy.
          persistCrashTimestamps(db, []);

          // Probe available agents. Failures are best-effort: the
          // chat-opencode driver checks `hasAgent('plan')` before
          // requesting plan mode and degrades gracefully when missing.
          const names = yield* Effect.tryPromise({
            try: () => probeAgents(running.client),
            catch: (err) => {
              debug(
                "opencode-supervisor",
                "agent probe failed:",
                err instanceof Error ? err.message : String(err),
              );
              return new Error("agent probe failed");
            },
          }).pipe(Effect.orElseSucceed(() => [] as readonly string[]));
          yield* Ref.update(stateRef, (s) => ({ ...s, agentNames: names }));
          debug("opencode-supervisor", `agent probe ok: ${names.join(", ")}`);

          return {
            port: running.port,
            hostname: running.hostname,
            password: running.password,
          };
        }),
      );

    const stopNow = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* clearIdleTimer();
        const s = yield* Ref.get(stateRef);
        if (s.running) {
          debug("opencode-supervisor", "stopNow — killing daemon");
          killRunning(s.running);
        }
        yield* Ref.update(stateRef, (st) => ({
          ...st,
          running: null,
          activeJobCount: 0,
          agentNames: null,
        }));
      });

    const scheduleIdleStop = (): Effect.Effect<void> =>
      Effect.sync(() => {
        void Effect.runPromise(
          Effect.gen(function* () {
            const s = yield* Ref.get(stateRef);
            if (s.idleTimer !== null) return;
            const timer = setTimeout(() => {
              void Effect.runPromise(stopIfIdle());
            }, IDLE_COOLDOWN_MS);
            yield* Ref.update(stateRef, (st) => ({ ...st, idleTimer: timer }));
          }),
        );
      });

    const stopIfIdle = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        const s = yield* Ref.get(stateRef);
        if (s.activeJobCount > 0) return;
        if (!s.running) {
          yield* clearIdleTimer();
          return;
        }
        debug("opencode-supervisor", "idle cooldown elapsed — stopping daemon");
        killRunning(s.running);
        yield* Ref.update(stateRef, (st) => ({
          ...st,
          running: null,
          idleTimer: null,
          agentNames: null,
        }));
      });

    const client = (): Effect.Effect<OpencodeClient | null> =>
      Effect.gen(function* () {
        const s = yield* Ref.get(stateRef);
        return s.running ? s.running.client : null;
      });

    const isHealthy = (): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        const s = yield* Ref.get(stateRef);
        return s.running !== null && !s.unhealthy;
      });

    const jobStarted = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        // Detect settings-change: if the selected agent moved away from
        // opencode while a running daemon exists, kill it.
        const agent = yield* resolveAgentName();
        const s0 = yield* Ref.get(stateRef);
        if (agent !== "opencode" && s0.running) {
          debug("opencode-supervisor", `selected agent changed to '${agent}' — stopping daemon`);
          yield* stopNow();
        }
        yield* clearIdleTimer();
        yield* Ref.update(stateRef, (s) => ({
          ...s,
          activeJobCount: s.activeJobCount + 1,
          lastSelectedAgent: agent,
        }));
        // Pre-warm: kick off daemon spawn in the background so it's ready
        // by the time the job calls ensureRunning(). Relies on ensureRunning's
        // own startPromise coalescing to safely handle concurrent calls.
        if (agent === "opencode") {
          void Effect.runPromise(ensureRunning().pipe(Effect.catchAll(() => Effect.void)));
        }
      });

    const jobEnded = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* Ref.update(stateRef, (s) => ({
          ...s,
          activeJobCount: Math.max(0, s.activeJobCount - 1),
        }));
        const s = yield* Ref.get(stateRef);
        if (s.activeJobCount === 0 && s.running) {
          yield* scheduleIdleStop();
        }
      });

    const onDaemonExit = (handler: () => void): (() => void) => {
      exitHandlers.add(handler);
      return () => {
        exitHandlers.delete(handler);
      };
    };

    const listAgents = (): Effect.Effect<readonly string[]> =>
      Effect.gen(function* () {
        const s = yield* Ref.get(stateRef);
        return s.agentNames ?? [];
      });

    const hasAgent = (name: string): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        const s = yield* Ref.get(stateRef);
        const names = s.agentNames;
        if (!names) return false;
        return names.includes(name);
      });

    return {
      ensureRunning,
      stopIfIdle,
      stopNow,
      client,
      isHealthy,
      jobStarted,
      jobEnded,
      onDaemonExit,
      listAgents,
      hasAgent,
    };
  }),
);
