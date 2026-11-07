import { homedir } from "node:os";
import { join } from "node:path";
import {
  type AcpAgentId,
  type AgentStatusReport,
  getAcpAgent,
  type InstallEvent,
} from "@revv/shared";
import { Context, Effect, Layer } from "effect";
import { detectAgentStatus } from "../ai/acp/agents";
import { addInstalledBinDirs, hostEnv, isCommandOnPath } from "../ai/acp/host";
import { debug, logError } from "../logger";
import { EventJobRegistry, type Job, type JobSubscription } from "./jobs/EventJobRegistry";

// Installs run through the shared `EventJobRegistry`: its ephemeral replay
// buffer lets a late SSE subscriber replay the full transcript and still react
// to `done`. Nothing is persisted; a kill -9 mid-install just re-shows the
// prompt on next boot.

export class OnboardingService extends Context.Service<
  OnboardingService,
  {
    /**
     * One-shot detection snapshot for the agent step — installed + authed +
     * login command per registry agent, plus whether this host supports the
     * embedded PTY login. The PATH probe is cached; the auth probes run each time.
     */
    detectAgentStatus: () => Effect.Effect<AgentStatusReport>;
    /**
     * Idempotent per agent: a racing second call returns the in-flight job's
     * id. Installs for different agents run independently.
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
>()("OnboardingService") {}

export const OnboardingServiceLive = Layer.effect(
  OnboardingService,
  Effect.gen(function* () {
    const jobs = new EventJobRegistry<InstallEvent, Record<string, never>>("onboarding-install");

    const drainStream = async (
      broadcast: (event: InstallEvent) => void,
      // Bun types `.stdout` this wide because a caller may request an fd; we
      // always pipe.
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
      const { cli } = getAcpAgent(job.agentId);
      const argv = [...cli.install];

      debug("onboarding-install", `spawning installer (${job.agentId}): ${argv.join(" ")}`);
      broadcast({ type: "log", line: `> ${argv.join(" ")}` });

      let proc: ReturnType<typeof Bun.spawn>;
      try {
        // The user's PATH, as every other agent spawn gets it: the desktop
        // app's own environment lacks their shell's (Homebrew, npm prefix).
        proc = Bun.spawn(argv, {
          stdout: "pipe",
          stderr: "pipe",
          env: hostEnv(),
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
        addInstalledBinDirs(cli.installBinDirs.map((dir) => join(homedir(), dir)));
        // Confirm the install with a strict PATH probe — NOT the auth-inclusive
        // availability check. An already-authed agent (e.g. Claude creds in the
        // Keychain) would make that check pass even if the installer exited 0
        // without placing the binary, falsely reporting success.
        const onPath = isCommandOnPath(cli.bin);
        const success = code === 0 && onPath;
        if (success) {
          broadcast({ type: "done", success: true });
        } else {
          const error =
            code !== 0
              ? `Installer exited with code ${code}`
              : `Installer finished but ${cli.bin} is still not on PATH`;
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
