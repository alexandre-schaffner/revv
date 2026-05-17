import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import type { AgentAvailability, InstallEvent } from "@revv/shared";
import { Context, Effect, Layer } from "effect";
import { checkCliAvailability, invalidateCliAgentCache } from "../ai/providers/cli-agent";
import { debug, logError } from "../logger";

// ── Onboarding service ──────────────────────────────────────────────────────
//
// One-shot installer plumbing the agent step of onboarding uses to:
//   1. Detect which CLI agents (opencode / claude) are present on PATH.
//   2. Run the official opencode install script when neither is detected.
//
// The install script lives upstream (https://opencode.ai/install for
// macOS/Linux, https://opencode.ai/install.ps1 for Windows). We spawn it
// once per server lifetime — a second `startInstall()` call returns the
// running job's id instead of double-spawning.
//
// Events are kept in a small in-memory log so a late SSE subscriber (e.g.
// the client tab that started the install reconnects after a slow render)
// can replay the full transcript and still react to `done` correctly. The
// log is purely ephemeral — a kill -9 mid-install just means the user
// sees the prompt again on next boot, which is the desired behavior.

const INSTALL_BIN_DIRS_UNIX = [".opencode/bin", ".local/bin"] as const;
const INSTALL_BIN_DIRS_WINDOWS = [".opencode/bin"] as const;

function detectAgentsSync(): AgentAvailability {
  return {
    opencode: checkCliAvailability("opencode"),
    claude: checkCliAvailability("claude"),
  };
}

/**
 * Prepend the directories the official opencode installer writes to
 * (`~/.opencode/bin` and friends) onto `process.env.PATH`, so the next
 * `which opencode` invocation finds the freshly-installed binary without
 * waiting for the user's shell config to be re-sourced or for a server
 * restart.
 */
function augmentPathForInstall(): void {
  const home = homedir();
  const sep = platform() === "win32" ? ";" : ":";
  const dirs =
    platform() === "win32"
      ? INSTALL_BIN_DIRS_WINDOWS.map((d) => join(home, d))
      : INSTALL_BIN_DIRS_UNIX.map((d) => join(home, d));
  const current = process.env.PATH ?? "";
  const existing = current.split(sep);
  const toPrepend = dirs.filter((d) => existsSync(d) && !existing.includes(d));
  if (toPrepend.length > 0) {
    process.env.PATH = [...toPrepend, current].join(sep);
  }
}

interface InstallJob {
  jobId: string;
  events: InstallEvent[];
  done: boolean;
  subscribers: Set<(event: InstallEvent) => void>;
}

/** Subscription handle returned by `subscribe`. */
export interface InstallSubscription {
  /** True when the job id matched and the subscriber is registered. */
  found: boolean;
  /** Drop the listener. Safe to call multiple times. */
  unsubscribe: () => void;
}

export class OnboardingService extends Context.Tag("OnboardingService")<
  OnboardingService,
  {
    /** Read PATH for opencode + claude. Cheap; cached per the cli-agent module's TTL. */
    detectAgents: () => Effect.Effect<AgentAvailability>;
    /**
     * Start the opencode install script if no job is running, or return the
     * id of the in-flight job. Always idempotent — callers can race and the
     * second one rides the first.
     */
    startInstallOpencode: () => Effect.Effect<{ jobId: string }>;
    /**
     * Register a callback that receives every `InstallEvent` for the job:
     * first the full replay buffer (fired synchronously before subscribe
     * returns), then live events as they arrive. If the job is already
     * terminal, the listener is fired through the replay and never
     * registered for live events.
     */
    subscribe: (
      jobId: string,
      onEvent: (event: InstallEvent) => void,
    ) => Effect.Effect<InstallSubscription>;
  }
>() {}

export const OnboardingServiceLive = Layer.effect(
  OnboardingService,
  Effect.gen(function* () {
    // Single-job state: install is process-lifetime idempotent. Holding
    // this in a closure (not a Ref) is intentional — the field is read
    // and written only from the service's own handlers, and ref-style
    // serialization buys us nothing here.
    let currentJob: InstallJob | null = null;

    const broadcast = (job: InstallJob, event: InstallEvent): void => {
      job.events.push(event);
      // Iterate over a snapshot — listeners may unsubscribe themselves
      // synchronously when they see `done`, mutating the underlying set.
      const snapshot = Array.from(job.subscribers);
      for (const sub of snapshot) {
        try {
          sub(event);
        } catch (err) {
          logError(
            "onboarding-install",
            "subscriber threw:",
            err instanceof Error ? err.message : String(err),
          );
        }
      }
      if (event.type === "done") {
        job.done = true;
        job.subscribers.clear();
      }
    };

    const drainStream = async (
      job: InstallJob,
      // Bun.spawn's `.stdout` is typed as `number | ReadableStream<Uint8Array>
      // | undefined` because callers can request a file-descriptor instead.
      // We always pipe, so a narrowing guard is enough to satisfy the type.
      stream: number | ReadableStream<Uint8Array> | undefined,
    ): Promise<void> => {
      if (!stream || typeof stream === "number") return;
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let nl = buffer.indexOf("\n");
          while (nl >= 0) {
            const line = buffer.slice(0, nl).replace(/\r$/, "");
            buffer = buffer.slice(nl + 1);
            if (line.length > 0) broadcast(job, { type: "log", line });
            nl = buffer.indexOf("\n");
          }
        }
        if (buffer.length > 0) broadcast(job, { type: "log", line: buffer });
      } catch (err) {
        logError(
          "onboarding-install",
          "stream drain failed:",
          err instanceof Error ? err.message : String(err),
        );
      } finally {
        try {
          reader.releaseLock();
        } catch {
          /* already released */
        }
      }
    };

    const spawnInstall = (job: InstallJob): void => {
      const isWindows = platform() === "win32";
      // Pipe the official installer into the matching shell. On macOS/Linux
      // we use `bash -c` (the installer is bash). On Windows the canonical
      // path is the PowerShell one-liner.
      const argv = isWindows
        ? [
            "powershell",
            "-NoProfile",
            "-Command",
            "iwr -useb https://opencode.ai/install.ps1 | iex",
          ]
        : ["bash", "-c", "curl -fsSL https://opencode.ai/install | bash"];

      debug("onboarding-install", `spawning installer: ${argv.join(" ")}`);
      broadcast(job, { type: "log", line: `> ${argv.join(" ")}` });

      let proc: ReturnType<typeof Bun.spawn>;
      try {
        proc = Bun.spawn(argv, {
          stdout: "pipe",
          stderr: "pipe",
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        broadcast(job, { type: "log", line: `Failed to start installer: ${message}` });
        broadcast(job, { type: "done", success: false, error: message });
        return;
      }

      void (async () => {
        await Promise.all([drainStream(job, proc.stdout), drainStream(job, proc.stderr)]);
        const code = await proc.exited;
        augmentPathForInstall();
        invalidateCliAgentCache();
        const installed = checkCliAvailability("opencode");
        const success = code === 0 && installed;
        if (success) {
          broadcast(job, { type: "done", success: true });
        } else {
          const error =
            code !== 0
              ? `Installer exited with code ${code}`
              : "Installer finished but opencode is still not on PATH";
          broadcast(job, { type: "done", success: false, error });
        }
      })();
    };

    return {
      detectAgents: () => Effect.sync(detectAgentsSync),

      startInstallOpencode: () =>
        Effect.sync(() => {
          if (currentJob && !currentJob.done) {
            return { jobId: currentJob.jobId };
          }
          const job: InstallJob = {
            jobId: crypto.randomUUID(),
            events: [],
            done: false,
            subscribers: new Set(),
          };
          currentJob = job;
          spawnInstall(job);
          return { jobId: job.jobId };
        }),

      subscribe: (jobId, onEvent) =>
        Effect.sync(() => {
          const job = currentJob;
          if (!job || job.jobId !== jobId) {
            return {
              found: false,
              unsubscribe: () => {
                /* no-op */
              },
            };
          }
          // Drain the replay synchronously so no `broadcast` can interleave
          // between snapshot and registration — the event loop can't run
          // an async install-stdout callback while this loop is hot. Once
          // registered below, future broadcasts arrive in strict order.
          for (const event of job.events) onEvent(event);
          if (job.done) {
            return {
              found: true,
              unsubscribe: () => {
                /* no-op — job already terminal */
              },
            };
          }
          job.subscribers.add(onEvent);
          return {
            found: true,
            unsubscribe: () => {
              job.subscribers.delete(onEvent);
            },
          };
        }),
    };
  }),
);
