import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Acquire a PID-file lock for this collector instance. If a live instance
 * already holds the lock it is SIGTERM'd (then SIGKILL'd after a grace period)
 * before this one binds its port. Mirrors apps/server/src/singleInstance.ts;
 * kept local to respect the monorepo's import boundaries (no cross-app reach).
 *
 * @returns a cleanup function that removes the PID file; call it on exit.
 */
export function acquireSingleInstance(pidFile: string): () => void {
  const dir = dirname(pidFile);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  if (existsSync(pidFile)) {
    const existingPid = parseInt(readFileSync(pidFile, "utf8").trim(), 10);
    if (!Number.isNaN(existingPid) && existingPid !== process.pid) {
      let alive = false;
      try {
        process.kill(existingPid, 0); // signal 0 throws ESRCH when gone
        alive = true;
      } catch {}

      if (alive) {
        console.error(`[collector] stale instance PID ${existingPid} — SIGTERM…`);
        try {
          process.kill(existingPid, "SIGTERM");
        } catch {}
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
          try {
            process.kill(existingPid, "SIGKILL");
          } catch {}
          Bun.sleepSync(200);
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
