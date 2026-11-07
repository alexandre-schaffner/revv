import type { AcpAgentId, LoginEvent } from "@revv/shared";
import { Context, Effect, Layer } from "effect";
import {
  agentLoginCommand,
  agentProcessEnv,
  detectAgentAuth,
  invalidateAgentProbes,
} from "../ai/acp/agents";
import { debug, logError } from "../logger";
import { EventJobRegistry, type Job, type JobSubscription } from "./EventJobRegistry";

// Runs the agent's official login command in a PTY so the user signs in inside
// Revv: terminal bytes stream to the onboarding xterm over SSE and keystrokes
// come back via `writeInput`. Nothing is persisted: a `kill -9` mid-login just
// means re-running it from the picker, and the next boot's auth re-check
// reflects whatever the CLI wrote to disk.

/** Default PTY geometry. The web's xterm fits to its container and the size is
 * cosmetic for these short login flows, so a sane fixed default is enough. */
const PTY_COLS = 80;
const PTY_ROWS = 24;

/** Matches the first URL the login CLI prints, so the UI can open it. */
const URL_RE = /https?:\/\/[^\s"'<>]+/;

interface LoginMeta {
  proc: ReturnType<typeof Bun.spawn> | null;
  urlScan: string;
  authUrlSent: boolean;
}

type LoginJob = Job<LoginEvent, LoginMeta>;

export class AgentLoginService extends Context.Service<
  AgentLoginService,
  {
    /**
     * Idempotent per agent: a second call returns the in-flight job's id.
     * Agents with no login command (opencode) get a job that immediately emits
     * a successful `done`.
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
>()("AgentLoginService") {}

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
        job.meta.urlScan = "";
      } else if (job.meta.urlScan.length > 64_000) {
        job.meta.urlScan = job.meta.urlScan.slice(-8_000);
      }
    };

    const spawnLogin = (job: LoginJob, broadcast: (event: LoginEvent) => void): void => {
      const argv = agentLoginCommand(job.agentId);
      if (!argv) {
        // No login needed (opencode) — succeed immediately and idempotently.
        broadcast({ type: "done", success: true });
        return;
      }

      debug("agent-login", `spawning login (${job.agentId}): ${argv.join(" ")}`);

      // The adapter's login env matches its spawn and auth probe: Claude's
      // Keychain item is scoped per config dir, so a login under another dir
      // would leave the agent logged out.
      const env = agentProcessEnv(job.agentId, "login");

      const decoder = new TextDecoder();
      let proc: ReturnType<typeof Bun.spawn>;
      try {
        proc = Bun.spawn([...argv], {
          env,
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
        invalidateAgentProbes();
        const success = await detectAgentAuth(job.agentId);
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
          // Retired so a re-opened sign-in spawns a fresh PTY rather than
          // rejoining a wedged one. The lingering `proc.exited` handler then
          // fires on a subscriber-less job, harmlessly.
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
