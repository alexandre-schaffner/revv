import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import {
  ACP_AGENT_IDS,
  type AcpAgentId,
  type AgentAvailability,
  type InstallEvent,
} from "@revv/shared";
import { Context, Effect, Layer } from "effect";
import {
  checkCliAvailability,
  invalidateCliAgentCache,
  isCommandOnPath,
} from "../ai/providers/cli-agent";
import { debug, logError } from "../logger";

// ── Onboarding service ──────────────────────────────────────────────────────
//
// One-shot installer plumbing the agent step of onboarding uses to:
//   1. Detect which registry agents' CLIs (opencode / claude / codex / cursor)
//      are present on PATH.
//   2. Run the official install script for whichever registry agent the user
//      selects when it isn't already present.
//
// Each agent ships an official one-line installer (see `AGENT_INSTALL`). We
// spawn it once per agent per server lifetime — a second `startInstall(agent)`
// call for an in-flight agent returns the running job's id instead of
// double-spawning. Installs for different agents run independently.
//
// Events are kept in a small in-memory log so a late SSE subscriber (e.g.
// the client tab that started the install reconnects after a slow render)
// can replay the full transcript and still react to `done` correctly. The
// log is purely ephemeral — a kill -9 mid-install just means the user
// sees the prompt again on next boot, which is the desired behavior.

/**
 * Per-agent install registry: the official one-line installer argv (POSIX vs
 * Windows) plus the home-relative bin dirs that installer writes to, which we
 * prepend to `PATH` so the freshly-installed binary is found without waiting
 * for a shell re-source or server restart.
 *
 * Mirrors the `Record<AcpAgentId, …>` shape used elsewhere in the registry so
 * adding an ACP agent surfaces a compile-time error here until its installer is
 * wired — a deliberate nudge. Commands track each vendor's published installer.
 */
const AGENT_INSTALL: Record<
  AcpAgentId,
  {
    unix: readonly string[];
    windows: readonly string[];
    binDirs: { unix: readonly string[]; windows: readonly string[] };
  }
> = {
  opencode: {
    unix: ["bash", "-c", "curl -fsSL https://opencode.ai/install | bash"],
    windows: [
      "powershell",
      "-NoProfile",
      "-Command",
      "iwr -useb https://opencode.ai/install.ps1 | iex",
    ],
    binDirs: { unix: [".opencode/bin", ".local/bin"], windows: [".opencode/bin"] },
  },
  "claude-code": {
    unix: ["bash", "-c", "curl -fsSL https://claude.ai/install.sh | bash"],
    windows: ["powershell", "-NoProfile", "-Command", "irm https://claude.ai/install.ps1 | iex"],
    binDirs: { unix: [".local/bin"], windows: [".local/bin"] },
  },
  codex: {
    unix: ["bash", "-c", "curl -fsSL https://chatgpt.com/codex/install.sh | sh"],
    windows: [
      "powershell",
      "-ExecutionPolicy",
      "ByPass",
      "-Command",
      "irm https://chatgpt.com/codex/install.ps1 | iex",
    ],
    binDirs: { unix: [".local/bin"], windows: [".local/bin"] },
  },
  cursor: {
    unix: ["bash", "-c", "curl https://cursor.com/install -fsS | bash"],
    windows: [
      "powershell",
      "-NoProfile",
      "-Command",
      "irm 'https://cursor.com/install?win32=true' | iex",
    ],
    binDirs: { unix: [".local/bin"], windows: [".local/bin"] },
  },
};

// Registry id → the CLI binary whose presence means the agent is set up
// locally. The legacy three honor their `REVV_*_BIN` pins via
// `checkCliAvailability`; Cursor's `cursor-agent` has no pin, so it's a bare
// PATH probe. Adding a registry agent surfaces a type error here until its
// detection is wired — a deliberate compile-time nudge.
const ACP_CLI_NAME: Record<AcpAgentId, "opencode" | "claude" | "codex" | "cursor-agent"> = {
  "claude-code": "claude",
  opencode: "opencode",
  codex: "codex",
  cursor: "cursor-agent",
};

function detectAgentCli(cli: (typeof ACP_CLI_NAME)[AcpAgentId]): boolean {
  return cli === "cursor-agent" ? isCommandOnPath(cli) : checkCliAvailability(cli);
}

function detectAgentsSync(): AgentAvailability {
  return Object.fromEntries(
    ACP_AGENT_IDS.map((id) => [id, detectAgentCli(ACP_CLI_NAME[id])]),
  ) as AgentAvailability;
}

/**
 * Prepend the directories the given agent's official installer writes to
 * (e.g. `~/.opencode/bin`, `~/.local/bin`) onto `process.env.PATH`, so the next
 * availability probe finds the freshly-installed binary without waiting for the
 * user's shell config to be re-sourced or for a server restart.
 */
function augmentPathForInstall(binDirs: {
  unix: readonly string[];
  windows: readonly string[];
}): void {
  const home = homedir();
  const isWindows = platform() === "win32";
  const sep = isWindows ? ";" : ":";
  const dirs = (isWindows ? binDirs.windows : binDirs.unix).map((d) => join(home, d));
  const current = process.env.PATH ?? "";
  const existing = current.split(sep);
  const toPrepend = dirs.filter((d) => existsSync(d) && !existing.includes(d));
  if (toPrepend.length > 0) {
    process.env.PATH = [...toPrepend, current].join(sep);
  }
}

interface InstallJob {
  jobId: string;
  agentId: AcpAgentId;
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
     * Start the given agent's official install script if no job for that agent
     * is running, or return the id of the in-flight job. Idempotent per agent —
     * callers can race and the second one rides the first. Installs for
     * different agents run independently.
     */
    startInstall: (agent: AcpAgentId) => Effect.Effect<{ jobId: string }>;
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
    // Per-agent job state: each agent's install is process-lifetime idempotent.
    // Holding this in a closure Map (not a Ref) is intentional — it's read and
    // written only from the service's own handlers, and ref-style serialization
    // buys us nothing here.
    const currentJobs = new Map<AcpAgentId, InstallJob>();

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
      const spec = AGENT_INSTALL[job.agentId];
      // Pipe the agent's official installer into the matching shell. On
      // macOS/Linux that's a `bash -c "curl … | sh"` line; on Windows it's the
      // vendor's PowerShell one-liner.
      const argv = [...(isWindows ? spec.windows : spec.unix)];

      debug("onboarding-install", `spawning installer (${job.agentId}): ${argv.join(" ")}`);
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
        augmentPathForInstall(spec.binDirs);
        invalidateCliAgentCache();
        const installed = detectAgentCli(ACP_CLI_NAME[job.agentId]);
        const success = code === 0 && installed;
        if (success) {
          broadcast(job, { type: "done", success: true });
        } else {
          const error =
            code !== 0
              ? `Installer exited with code ${code}`
              : `Installer finished but ${ACP_CLI_NAME[job.agentId]} is still not on PATH`;
          broadcast(job, { type: "done", success: false, error });
        }
      })();
    };

    return {
      detectAgents: () => Effect.sync(detectAgentsSync),

      startInstall: (agent) =>
        Effect.sync(() => {
          const running = currentJobs.get(agent);
          if (running && !running.done) {
            return { jobId: running.jobId };
          }
          const job: InstallJob = {
            jobId: crypto.randomUUID(),
            agentId: agent,
            events: [],
            done: false,
            subscribers: new Set(),
          };
          currentJobs.set(agent, job);
          spawnInstall(job);
          return { jobId: job.jobId };
        }),

      subscribe: (jobId, onEvent) =>
        Effect.sync(() => {
          // Resolve the job by id across all per-agent slots.
          const job = Array.from(currentJobs.values()).find((j) => j.jobId === jobId);
          if (!job) {
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
