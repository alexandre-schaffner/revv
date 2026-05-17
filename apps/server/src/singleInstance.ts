import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { logError } from "./logger";

/**
 * Acquires a PID-file lock for this server instance.
 *
 * If another process holds the same PID file and is still alive:
 *   1. SIGTERM it and wait up to 3 s for a clean exit.
 *   2. SIGKILL it if it is still running after the grace period.
 *
 * Writes this process's PID to `pidFile` so the next startup can do the same.
 *
 * @returns A cleanup function that removes the PID file; call it on exit.
 */
export function acquireSingleInstance(pidFile: string): () => void {
  const dir = dirname(pidFile);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  if (existsSync(pidFile)) {
    const raw = readFileSync(pidFile, "utf8").trim();
    const existingPid = parseInt(raw, 10);

    if (!Number.isNaN(existingPid) && existingPid !== process.pid) {
      // signal(0) is a no-op that throws ESRCH when the process is gone
      let alive = false;
      try {
        process.kill(existingPid, 0);
        alive = true;
      } catch {
        // ESRCH — process is already dead; stale PID file
      }

      if (alive) {
        logError("server", `[single-instance] stale instance PID ${existingPid} — SIGTERM…`);
        try {
          process.kill(existingPid, "SIGTERM");
        } catch {}

        // Busy-wait up to 3 s for the old process to exit cleanly.
        // This runs synchronously at startup before we bind any port, so
        // blocking the event loop here is harmless.
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          try {
            process.kill(existingPid, 0); // still alive
            Bun.sleepSync(100);
          } catch {
            alive = false;
            break;
          }
        }

        if (alive) {
          logError("server", `[single-instance] PID ${existingPid} did not exit — SIGKILL`);
          try {
            process.kill(existingPid, "SIGKILL");
          } catch {}
          Bun.sleepSync(200);
        } else {
          logError("server", `[single-instance] PID ${existingPid} exited cleanly`);
        }
      }
    }
  }

  writeFileSync(pidFile, String(process.pid), "utf8");

  return () => {
    try {
      unlinkSync(pidFile);
    } catch {}
  };
}
