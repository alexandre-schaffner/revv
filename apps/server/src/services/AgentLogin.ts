import { platform } from "node:os";
import type { AcpAgentId, LoginEvent } from "@revv/shared";
import { Context, Effect, Layer } from "effect";
import {
  detectAgentAuth,
  invalidateCliAgentCache,
  resolveAgentLoginCommand,
  resolveUserPath,
} from "../ai/providers/cli-agent";
import { debug, logError } from "../logger";
import { EventJobRegistry, type Job, type JobSubscription } from "./jobs/EventJobRegistry";

// ── Agent login service ───────────────────────────────────────────────────────
//
// Drives an agent's interactive CLI login *inside Revv* rather than sending the
// user out to a separate terminal. Each login runs the agent's official login
// command (see `ACP_LOGIN_COMMAND` in cli-agent.ts) in a spawned
// pseudo-terminal (PTY); the raw terminal bytes stream to the onboarding UI's
// xterm instance over SSE, and the user's keystrokes flow back via `writeInput`.
//
// The pub/sub plumbing (per-agent idempotent job map, replay buffer,
// late-subscriber replay, commit-then-broadcast) lives in the shared
// `EventJobRegistry`. The only login-specific state is the PTY: a login is
// interactive, so the subprocess handle rides on the job's `meta` so keystrokes
// can be written to its terminal and the output scanned for the first auth URL.
// `cancelLogin` tears that PTY down so an abandoned login never orphans a
// long-lived interactive CLI on the server.
//
// State is intentionally ephemeral — a `kill -9` mid-login just means the user
// re-runs the login from the picker, and the auth re-check on next boot reflects
// whatever the CLI actually persisted to disk.

/** Default PTY geometry. The web's xterm fits to its container and the size is
 * cosmetic for these short login flows, so a sane fixed default is enough. */
const PTY_COLS = 80;
const PTY_ROWS = 24;

/** Matches the first URL the login CLI prints, so the UI can open it. */
const URL_RE = /https?:\/\/[^\s"'<>]+/;

/** Login-specific job state carried on the registry job's `meta` slot. */
interface LoginMeta {
  /** Live subprocess so `writeInput` can forward keystrokes to its PTY. */
  proc: ReturnType<typeof Bun.spawn> | null;
  /** Accumulated stdout, scanned once for the first auth URL. */
  urlScan: string;
  /** True once an `auth-url` event has been emitted (emit at most once). */
  authUrlSent: boolean;
}

type LoginJob = Job<LoginEvent, LoginMeta>;

export class AgentLoginService extends Context.Tag("AgentLoginService")<
  AgentLoginService,
  {
    /**
     * Start the agent's interactive login in a PTY if no login for that agent is
     * running, or return the id of the in-flight job. Idempotent per agent.
     * Agents with no login command (opencode) get a job that immediately emits a
     * successful `done`.
     */
    startLogin: (agent: AcpAgentId) => Effect.Effect<{ jobId: string }>;
    /** Forward a chunk of user input to the login job's PTY. No-op if unknown/terminal. */
    writeInput: (jobId: string, data: string) => Effect.Effect<{ ok: boolean }>;
    /**
     * Kill the login job's PTY and retire the job, so an abandoned login (skip /
     * unmount / navigate-away) never leaves a long-lived interactive CLI running
     * on the server. Idempotent and safe on unknown/already-finished jobs.
     */
    cancelLogin: (jobId: string) => Effect.Effect<{ ok: boolean }>;
    /**
     * Register a callback that receives every `LoginEvent` for the job: first the
     * full replay buffer (fired synchronously before subscribe returns), then
     * live events. If the job is already terminal the listener fires through the
     * replay and is never registered for live events.
     */
    subscribe: (
      jobId: string,
      onEvent: (event: LoginEvent) => void,
    ) => Effect.Effect<JobSubscription>;
  }
>() {}

export const AgentLoginServiceLive = Layer.effect(
  AgentLoginService,
  Effect.gen(function* () {
    const jobs = new EventJobRegistry<LoginEvent, LoginMeta>("agent-login");

    const scanForAuthUrl = (
      job: LoginJob,
      chunk: string,
      broadcast: (event: LoginEvent) => void,
    ): void => {
      if (job.meta.authUrlSent) return;
      job.meta.urlScan += chunk;
      const match = URL_RE.exec(job.meta.urlScan);
      if (match) {
        job.meta.authUrlSent = true;
        broadcast({ type: "auth-url", url: match[0] });
        // The scan buffer has served its purpose — drop it to bound memory.
        job.meta.urlScan = "";
      } else if (job.meta.urlScan.length > 64_000) {
        // Bound the scan buffer if the CLI never prints a URL.
        job.meta.urlScan = job.meta.urlScan.slice(-8_000);
      }
    };

    const spawnLogin = (job: LoginJob, broadcast: (event: LoginEvent) => void): void => {
      const argv = resolveAgentLoginCommand(job.agentId);
      if (!argv) {
        // No login needed (opencode) — succeed immediately and idempotently.
        broadcast({ type: "done", success: true });
        return;
      }

      // PTY is POSIX-only; Windows degrades to a browser-handoff path the UI
      // owns, so we don't attempt to spawn a terminal there.
      if (platform() === "win32") {
        broadcast({
          type: "done",
          success: false,
          error:
            "Embedded sign-in isn't supported on Windows yet — open the agent's CLI to log in.",
        });
        return;
      }

      debug("agent-login", `spawning login (${job.agentId}): ${argv.join(" ")}`);

      const decoder = new TextDecoder();
      let proc: ReturnType<typeof Bun.spawn>;
      try {
        proc = Bun.spawn([...argv], {
          // Resolve against the user's login-shell PATH so a freshly-installed
          // CLI (e.g. `cursor-agent`) is found without a server restart.
          env: { ...process.env, PATH: resolveUserPath() },
          terminal: {
            cols: PTY_COLS,
            rows: PTY_ROWS,
            data: (_term, bytes) => {
              const chunk = decoder.decode(bytes, { stream: true });
              if (chunk.length > 0) {
                broadcast({ type: "data", chunk });
                scanForAuthUrl(job, chunk, broadcast);
              }
            },
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        broadcast({ type: "data", chunk: `\r\nFailed to start login: ${message}\r\n` });
        broadcast({ type: "done", success: false, error: message });
        return;
      }
      job.meta.proc = proc;

      void (async () => {
        const code = await proc.exited;
        // The CLI just wrote credentials to disk — drop the cached PATH/auth
        // probe so the re-check sees them.
        invalidateCliAgentCache();
        const success = detectAgentAuth(job.agentId);
        if (success) {
          broadcast({ type: "done", success: true });
        } else {
          const error =
            code === 0
              ? `Login finished but ${job.agentId} still isn't authenticated`
              : `Login exited with code ${code}`;
          broadcast({ type: "done", success: false, error });
        }
      })();
    };

    return {
      startLogin: (agent) =>
        Effect.sync(() =>
          jobs.start(agent, () => ({ proc: null, urlScan: "", authUrlSent: false }), spawnLogin),
        ),

      writeInput: (jobId, data) =>
        Effect.sync(() => {
          const job = jobs.findById(jobId);
          if (!job || job.done || !job.meta.proc) return { ok: false };
          try {
            job.meta.proc.terminal?.write(data);
            return { ok: true };
          } catch (err) {
            logError(
              "agent-login",
              "write input failed:",
              err instanceof Error ? err.message : String(err),
            );
            return { ok: false };
          }
        }),

      cancelLogin: (jobId) =>
        Effect.sync(() => {
          const job = jobs.findById(jobId);
          if (!job) return { ok: false };
          // Kill the interactive CLI (best-effort) and retire the job so a
          // re-opened sign-in for this agent spawns a fresh PTY rather than
          // rejoining a wedged one. The lingering `proc.exited` handler then
          // fires on a subscriber-less job — harmless.
          try {
            job.meta.proc?.kill();
          } catch (err) {
            logError(
              "agent-login",
              "kill login proc failed:",
              err instanceof Error ? err.message : String(err),
            );
          }
          jobs.delete(jobId);
          return { ok: true };
        }),

      subscribe: (jobId, onEvent) => Effect.sync(() => jobs.subscribe(jobId, onEvent)),
    };
  }),
);
