import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { logError } from "./logger";

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
      } catch {}

      if (alive) {
        logError("server", `[single-instance] stale instance PID ${existingPid} — SIGTERM…`);
        try {
          process.kill(existingPid, "SIGTERM");
        } catch {}

        // Blocking the event loop is harmless: this runs at startup, before any port
        // is bound.
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          try {
            process.kill(existingPid, 0);
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
