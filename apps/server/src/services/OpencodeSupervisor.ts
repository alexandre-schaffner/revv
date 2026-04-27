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
// All HTTP to opencode uses Bun's native fetch. Basic-auth password is sent
// on every request as `Authorization: Basic <base64(opencode:PASSWORD)>`.
// SSE event stream from `/event` is consumed via fetch + manual line
// buffering; see subscribeToEvents below.

import { Context, Effect, Layer, Ref } from "effect";
import { resolveCliBin } from "../ai/providers/cli-agent";
import { type AiError, AiGenerationError } from "../domain/errors";
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

export interface OpencodeMcpRegistration {
  readonly name: string;
  readonly config: {
    readonly type: "remote";
    readonly url: string;
    readonly headers?: Record<string, string>;
  };
}

export interface OpencodeSessionCreate {
  readonly title?: string;
  readonly parentID?: string;
}

export interface OpencodePostMessage {
  readonly sessionId: string;
  readonly model?: string;
  readonly agent?: string;
  readonly parts: unknown[];
  readonly tools?: unknown;
  readonly system?: string;
  readonly noReply?: boolean;
}

export interface OpencodeSubscribe {
  readonly sessionId: string;
  readonly signal: AbortSignal;
  readonly onEvent: (ev: unknown) => void;
}

export interface OpencodeHttpClient {
  registerMcp(params: OpencodeMcpRegistration): Promise<void>;
  createSession(params: OpencodeSessionCreate): Promise<{ id: string }>;
  postMessage(params: OpencodePostMessage): Promise<unknown>;
  abortSession(sessionId: string): Promise<void>;
  /**
   * Open an SSE subscription to /event filtered by sessionId. Resolves when
   * the server closes the stream (or signal aborts); `onEvent` is called
   * once per JSON-parsed event. Non-matching events are skipped.
   */
  subscribeToEvents(opts: OpencodeSubscribe): Promise<void>;
}

export type OpencodeError = AiError;

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
    readonly ensureRunning: () => Effect.Effect<
      OpencodeEndpoint,
      OpencodeError
    >;
    /**
     * Decrement job count and schedule a stop if idle (30s cooldown).
     * Idempotent — safe to call even with no active job.
     */
    readonly stopIfIdle: () => Effect.Effect<void>;
    /** Immediately kill the daemon. */
    readonly stopNow: () => Effect.Effect<void>;
    /** Current HTTP client. Null when daemon is not running. */
    readonly client: () => Effect.Effect<OpencodeHttpClient | null>;
    readonly isHealthy: () => Effect.Effect<boolean>;
    /** Signal a job has started — bumps refcount, cancels any idle timer. */
    readonly jobStarted: () => Effect.Effect<void>;
    /** Signal a job has ended — may schedule cooldown stop. */
    readonly jobEnded: () => Effect.Effect<void>;
  }
>() {}

// ── Internal state ───────────────────────────────────────────────────────────

interface RunningState {
  readonly port: number;
  readonly hostname: string;
  readonly password: string;
  readonly proc: ReturnType<typeof Bun.spawn>;
  readonly client: OpencodeHttpClient;
}

interface SupervisorState {
  readonly running: RunningState | null;
  readonly activeJobCount: number;
  readonly idleTimer: ReturnType<typeof setTimeout> | null;
  readonly restartTimestamps: readonly number[];
  readonly unhealthy: boolean;
  readonly lastSelectedAgent: string | null;
  readonly startPromise: Promise<RunningState> | null;
}

const INITIAL_STATE: SupervisorState = {
  running: null,
  activeJobCount: 0,
  idleTimer: null,
  restartTimestamps: [],
  unhealthy: false,
  lastSelectedAgent: null,
  startPromise: null,
};

const IDLE_COOLDOWN_MS = 30_000;
const CRASH_LOOP_WINDOW_MS = 60_000;
const CRASH_LOOP_MAX = 3;
const HEALTH_POLL_INTERVAL_MS = 250;
const HEALTH_POLL_TIMEOUT_MS = 15_000;

function randomPassword(): string {
  // 32 bytes of cryptographically strong randomness, base64url-encoded.
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  let binary = "";
  for (const b of buf) binary += String.fromCharCode(b);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function basicAuthHeader(password: string): string {
  return `Basic ${btoa(`opencode:${password}`)}`;
}

// ── HTTP client construction ─────────────────────────────────────────────────

function buildHttpClient(
  hostname: string,
  port: number,
  password: string,
): OpencodeHttpClient {
  const baseUrl = `http://${hostname}:${port}`;
  const authHeader = basicAuthHeader(password);

  async function request(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: authHeader,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(extraHeaders ?? {}),
    };
    const init: RequestInit = {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    };
    const res = await fetch(`${baseUrl}${path}`, init);
    return res;
  }

  return {
    async registerMcp(params) {
      // TODO(verify): the exact request path/shape for registering a remote
      // MCP server on a running `opencode serve` daemon needs confirmation
      // against the opencode OpenAPI. We post to /mcp/register with a JSON
      // body of { name, config }. If the route differs, adjust here.
      const res = await request("POST", "/mcp/register", {
        name: params.name,
        config: params.config,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(
          `opencode mcp register failed (${res.status}): ${text.slice(0, 400)}`,
        );
      }
    },

    async createSession(params) {
      const res = await request("POST", "/session", {
        ...(params.title !== undefined ? { title: params.title } : {}),
        ...(params.parentID !== undefined ? { parentID: params.parentID } : {}),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(
          `opencode createSession failed (${res.status}): ${text.slice(0, 400)}`,
        );
      }
      const json = (await res.json()) as { id?: string };
      if (!json.id) throw new Error("opencode createSession returned no id");
      return { id: json.id };
    },

    async postMessage(params) {
      const { sessionId, ...rest } = params;
      const res = await request(
        "POST",
        `/session/${encodeURIComponent(sessionId)}/message`,
        rest,
      );
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(
          `opencode postMessage failed (${res.status}): ${text.slice(0, 400)}`,
        );
      }
      return (await res.json().catch(() => ({}))) as unknown;
    },

    async abortSession(sessionId) {
      const res = await request(
        "POST",
        `/session/${encodeURIComponent(sessionId)}/abort`,
      );
      if (!res.ok && res.status !== 404) {
        const text = await res.text().catch(() => "");
        logError(
          "opencode-supervisor",
          `abortSession non-ok (${res.status}): ${text.slice(0, 200)}`,
        );
      }
    },

    async subscribeToEvents({ sessionId, signal, onEvent }) {
      // The /event endpoint is a global SSE stream. We filter by session id
      // client-side. See https://opencode.ai for the envelope shape; at the
      // time of writing events carry a `.properties.sessionID` or similar
      // discriminator. TODO(verify): confirm the exact field name once the
      // daemon is wired up end-to-end; if it differs, update the filter.
      const res = await fetch(`${baseUrl}/event`, {
        method: "GET",
        headers: {
          Authorization: authHeader,
          Accept: "text/event-stream",
        },
        signal,
      });
      if (!res.ok) {
        throw new Error(
          `opencode /event subscribe failed (${res.status}): ${await res
            .text()
            .catch(() => "")}`,
        );
      }
      const body = res.body;
      if (!body) throw new Error("opencode /event returned empty body");
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (true) {
          if (signal.aborted) break;
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          // SSE framing: events are separated by blank lines; each
          // event is one or more `<field>: <value>` lines. We only
          // care about `data:` lines; accumulate until blank-line.
          let sep = buffer.indexOf("\n\n");
          while (sep !== -1) {
            const frame = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            const dataLines: string[] = [];
            for (const line of frame.split("\n")) {
              if (line.startsWith("data:")) {
                dataLines.push(line.slice(5).trimStart());
              }
            }
            if (dataLines.length > 0) {
              const payload = dataLines.join("\n");
              try {
                const parsed = JSON.parse(payload);
                const sid = extractSessionId(parsed);
                if (sid === null || sid === sessionId) {
                  onEvent(parsed);
                }
              } catch {
                /* ignore non-JSON frames */
              }
            }
            sep = buffer.indexOf("\n\n");
          }
        }
      } finally {
        try {
          reader.releaseLock();
        } catch {
          /* ignore */
        }
      }
    },
  };
}

function extractSessionId(ev: unknown): string | null {
  if (ev === null || typeof ev !== "object") return null;
  const obj = ev as Record<string, unknown>;
  const props =
    obj.properties && typeof obj.properties === "object"
      ? (obj.properties as Record<string, unknown>)
      : obj;
  const candidates = ["sessionID", "sessionId", "session_id", "session"];
  for (const key of candidates) {
    const v = props[key];
    if (typeof v === "string") return v;
  }
  return null;
}

// ── Live implementation ──────────────────────────────────────────────────────

export const OpencodeSupervisorLive = Layer.effect(
  OpencodeSupervisor,
  Effect.gen(function* () {
    const { db } = yield* DbService;
    const settingsService = yield* SettingsService;
    const stateRef = yield* Ref.make<SupervisorState>(INITIAL_STATE);

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
    ): Promise<void> => {
      const deadline = Date.now() + HEALTH_POLL_TIMEOUT_MS;
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
      throw new Error(
        `opencode serve did not become healthy within ${HEALTH_POLL_TIMEOUT_MS}ms`,
      );
    };

    const parsePortFromLog = (chunk: string): number | null => {
      // opencode logs a line like "listening on 127.0.0.1:<port>" when it
      // binds. We tolerate a range of formats to be safe.
      const patterns = [
        /listening on [^\s:]+:(\d+)/i,
        /listening on port (\d+)/i,
        /opencode server listening on .*:(\d+)/i,
        /http:\/\/[^\s:]+:(\d+)/i,
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

    const spawnDaemon = async (): Promise<RunningState> => {
      const password = randomPassword();
      const hostname = "127.0.0.1";
      const bin = resolveCliBin("opencode");
      debug("opencode-supervisor", "spawning", bin, "serve");
      const proc = Bun.spawn(
        [bin, "serve", "--port", "0", "--hostname", hostname],
        {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...process.env,
            OPENCODE_SERVER_PASSWORD: password,
          },
        },
      );

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
      const portPromise = new Promise<number>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(
            new Error(
              `opencode serve did not log its port within ${HEALTH_POLL_TIMEOUT_MS}ms`,
            ),
          );
        }, HEALTH_POLL_TIMEOUT_MS);
        portWaiters.push((p) => {
          clearTimeout(timeout);
          resolve(p);
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
      await waitForHealth(hostname, port, password);

      const client = buildHttpClient(hostname, port, password);
      const running: RunningState = { hostname, port, password, proc, client };

      // Wire exit handler so we know when the daemon dies unexpectedly and
      // can update state (and consider auto-restart).
      void proc.exited.then((code) => {
        void Effect.runPromise(
          Effect.gen(function* () {
            const s = yield* Ref.get(stateRef);
            if (s.running !== running) return; // already replaced
            debug(
              "opencode-supervisor",
              `daemon exited (code=${code}) — clearing running state`,
            );
            yield* Ref.update(stateRef, (st) => ({
              ...st,
              running: null,
            }));
            if (s.activeJobCount > 0 && !s.unhealthy) {
              // Unexpected crash while work is in flight — record a
              // restart timestamp for crash-loop accounting. The next
              // ensureRunning() call performs the actual respawn.
              const now = Date.now();
              const recent = s.restartTimestamps.filter(
                (t) => now - t < CRASH_LOOP_WINDOW_MS,
              );
              const nextCount = recent.length + 1;
              const nextStamps = [...recent, now];
              const unhealthy = nextCount >= CRASH_LOOP_MAX;
              yield* Ref.update(stateRef, (st) => ({
                ...st,
                restartTimestamps: nextStamps,
                unhealthy,
              }));
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
      Effect.gen(function* () {
        // Cancel any pending idle stop — someone wants the daemon.
        yield* clearIdleTimer();

        const snapshot = yield* Ref.get(stateRef);

        // Detect agent-change and stop if we're no longer 'opencode'.
        const agent = yield* resolveAgentName();
        if (agent !== "opencode") {
          yield* stopNow();
          return yield* Effect.fail(
            new AiGenerationError({
              cause: new Error(`selected agent is '${agent}', not 'opencode'`),
              message: `OpencodeSupervisor.ensureRunning() called while selected agent is '${agent}'`,
            }),
          );
        }

        if (snapshot.unhealthy) {
          return yield* Effect.fail(
            new AiGenerationError({
              cause: new Error("opencode daemon marked unhealthy (crash loop)"),
              message:
                "opencode daemon is unhealthy after repeated crashes — inspect logs and restart Revv",
            }),
          );
        }

        if (snapshot.running) {
          return {
            port: snapshot.running.port,
            hostname: snapshot.running.hostname,
            password: snapshot.running.password,
          };
        }

        // Coalesce concurrent starts onto a single promise.
        if (snapshot.startPromise) {
          const running = yield* Effect.tryPromise({
            try: () => snapshot.startPromise!,
            catch: (err) =>
              new AiGenerationError({
                cause: err,
                message: err instanceof Error ? err.message : String(err),
              }),
          });
          return {
            port: running.port,
            hostname: running.hostname,
            password: running.password,
          };
        }

        const promise = spawnDaemon();
        yield* Ref.update(stateRef, (s) => ({ ...s, startPromise: promise }));

        const running = yield* Effect.tryPromise({
          try: () => promise,
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
        }).pipe(
          Effect.ensuring(
            Ref.update(stateRef, (s) => ({
              ...s,
              startPromise: null,
            })),
          ),
        );

        yield* Ref.update(stateRef, (s) => ({
          ...s,
          running,
          lastSelectedAgent: agent,
          // Successful start resets the crash-loop counter.
          restartTimestamps: [],
          unhealthy: false,
        }));

        return {
          port: running.port,
          hostname: running.hostname,
          password: running.password,
        };
      });

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
        }));
      });

    const client = (): Effect.Effect<OpencodeHttpClient | null> =>
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
          debug(
            "opencode-supervisor",
            `selected agent changed to '${agent}' — stopping daemon`,
          );
          yield* stopNow();
        }
        yield* clearIdleTimer();
        yield* Ref.update(stateRef, (s) => ({
          ...s,
          activeJobCount: s.activeJobCount + 1,
          lastSelectedAgent: agent,
        }));
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

    return {
      ensureRunning,
      stopIfIdle,
      stopNow,
      client,
      isHealthy,
      jobStarted,
      jobEnded,
    };
  }),
);
