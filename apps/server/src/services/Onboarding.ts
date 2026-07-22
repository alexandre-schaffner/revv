import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AcpAgentId, AgentStatusReport, InstallEvent } from "@revv/shared";
import { Context, Effect, Layer } from "effect";
import {
  ACP_CLI_NAME,
  detectAgentStatus,
  invalidateCliAgentCache,
  isCommandOnPath,
} from "../ai/providers/cli-agent";
import { debug, logError } from "../logger";
import { EventJobRegistry, type Job, type JobSubscription } from "./jobs/EventJobRegistry";

// ── Onboarding service ──────────────────────────────────────────────────────
//
// One-shot installer plumbing the agent step of onboarding uses to:
//   1. Detect which registry agents are set up — see `detectAgentStatus` in
//      `cli-agent.ts`, the single detection surface (installed + authed).
//   2. Run the official install script for whichever registry agent the user
//      selects when it isn't already present.
//
// Each agent ships an official one-line installer (see `AGENT_INSTALL`). We
// spawn it once per agent per server lifetime via the shared
// `EventJobRegistry` — a second `startInstall(agent)` call for an in-flight
// agent rides the running job instead of double-spawning. Installs for
// different agents run independently. The registry's ephemeral replay buffer
// lets a late SSE subscriber replay the full transcript and still react to
// `done`; a kill -9 mid-install just re-shows the prompt on next boot.

/**
 * Per-agent install registry: the official one-line installer argv plus the
 * home-relative bin dirs that installer writes to, which we prepend to `PATH`
 * so the freshly-installed binary is found without waiting for a shell
 * re-source or server restart.
 *
 * Mirrors the `Record<AcpAgentId, …>` shape used elsewhere in the registry so
 * adding an ACP agent surfaces a compile-time error here until its installer is
 * wired — a deliberate nudge. Commands track each vendor's published installer.
 */
const AGENT_INSTALL: Record<
  AcpAgentId,
  {
    unix: readonly string[];
    binDirs: readonly string[];
  }
> = {
  opencode: {
    unix: ["bash", "-c", "curl -fsSL https://opencode.ai/install | bash"],
    binDirs: [".opencode/bin", ".local/bin"],
  },
  "claude-code": {
    unix: ["bash", "-c", "curl -fsSL https://claude.ai/install.sh | bash"],
    binDirs: [".local/bin"],
  },
  codex: {
    unix: ["bash", "-c", "curl -fsSL https://chatgpt.com/codex/install.sh | sh"],
    binDirs: [".local/bin"],
  },
  cursor: {
    unix: ["bash", "-c", "curl https://cursor.com/install -fsS | bash"],
    binDirs: [".local/bin"],
  },
};

/**
 * Prepend the directories the given agent's official installer writes to
 * (e.g. `~/.opencode/bin`, `~/.local/bin`) onto `process.env.PATH`, so the next
 * availability probe finds the freshly-installed binary without waiting for the
 * user's shell config to be re-sourced or for a server restart.
 */
function augmentPathForInstall(binDirs: readonly string[]): void {
  const home = homedir();
  const dirs = binDirs.map((d) => join(home, d));
  const current = process.env.PATH ?? "";
  const existing = current.split(":");
  const toPrepend = dirs.filter((d) => existsSync(d) && !existing.includes(d));
  if (toPrepend.length > 0) {
    process.env.PATH = [...toPrepend, current].join(":");
  }
}

export class OnboardingService extends Context.Tag("OnboardingService")<
  OnboardingService,
  {
    /**
     * One-shot detection snapshot for the agent step — installed + authed +
     * login command per registry agent, plus whether this host supports the
     * embedded PTY login. Cheap; cached per the cli-agent module's TTL.
     */
    detectAgentStatus: () => Effect.Effect<AgentStatusReport>;
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
    ) => Effect.Effect<JobSubscription>;
  }
>() {}

export const OnboardingServiceLive = Layer.effect(
  OnboardingService,
  Effect.gen(function* () {
    const jobs = new EventJobRegistry<InstallEvent, Record<string, never>>("onboarding-install");

    const drainStream = async (
      broadcast: (event: InstallEvent) => void,
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
            if (line.length > 0) broadcast({ type: "log", line });
            nl = buffer.indexOf("\n");
          }
        }
        if (buffer.length > 0) broadcast({ type: "log", line: buffer });
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

    const spawnInstall = (
      job: Job<InstallEvent, Record<string, never>>,
      broadcast: (event: InstallEvent) => void,
    ): void => {
      const spec = AGENT_INSTALL[job.agentId];
      // Pipe the agent's official installer into a shell — a
      // `bash -c "curl … | sh"` line.
      const argv = [...spec.unix];

      debug("onboarding-install", `spawning installer (${job.agentId}): ${argv.join(" ")}`);
      broadcast({ type: "log", line: `> ${argv.join(" ")}` });

      let proc: ReturnType<typeof Bun.spawn>;
      try {
        proc = Bun.spawn(argv, {
          stdout: "pipe",
          stderr: "pipe",
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        broadcast({ type: "log", line: `Failed to start installer: ${message}` });
        broadcast({ type: "done", success: false, error: message });
        return;
      }

      void (async () => {
        await Promise.all([
          drainStream(broadcast, proc.stdout),
          drainStream(broadcast, proc.stderr),
        ]);
        const code = await proc.exited;
        augmentPathForInstall(spec.binDirs);
        invalidateCliAgentCache();
        // Confirm the install with a strict PATH probe — NOT the auth-inclusive
        // availability check. An already-authed agent (e.g. Claude creds in the
        // Keychain) would make that check pass even if the installer exited 0
        // without placing the binary, falsely reporting success.
        const cli = ACP_CLI_NAME[job.agentId];
        const onPath = isCommandOnPath(cli);
        const success = code === 0 && onPath;
        if (success) {
          broadcast({ type: "done", success: true });
        } else {
          const error =
            code !== 0
              ? `Installer exited with code ${code}`
              : `Installer finished but ${cli} is still not on PATH`;
          broadcast({ type: "done", success: false, error });
        }
      })();
    };

    return {
      detectAgentStatus: () => Effect.sync(detectAgentStatus),

      startInstall: (agent) => Effect.sync(() => jobs.start(agent, () => ({}), spawnInstall)),

      subscribe: (jobId, onEvent) => Effect.sync(() => jobs.subscribe(jobId, onEvent)),
    };
  }),
);
