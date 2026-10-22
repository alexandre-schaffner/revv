import { join } from "node:path";
import { COLLECTOR_PORT } from "../packages/shared/src/constants";

// A machine-level collector may already be gathering installed-app sessions.
// Keep concurrently's task alive without taking its database or port away.
let running = false;
try {
  const response = await fetch(`http://127.0.0.1:${COLLECTOR_PORT}/api/health`, {
    signal: AbortSignal.timeout(1000),
  });
  const body: unknown = response.ok ? await response.json() : null;
  running =
    typeof body === "object" &&
    body !== null &&
    "service" in body &&
    body.service === "revv-collector";
} catch {
  // No existing collector: start the normal source watcher below.
}

if (running) {
  console.error(`[collector] reusing the running collector on :${COLLECTOR_PORT}`);
  await new Promise<void>((resolve) => {
    const keepAlive = setInterval(() => {}, 60_000);
    const stop = () => {
      clearInterval(keepAlive);
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
} else {
  const child = Bun.spawn([process.execPath, "run", "--watch", "src/index.ts"], {
    cwd: join(import.meta.dir, "../apps/collector"),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  process.once("SIGINT", () => child.kill("SIGINT"));
  process.once("SIGTERM", () => child.kill("SIGTERM"));
  process.exitCode = await child.exited;
}
