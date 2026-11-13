// Local OTLP archive and query API that every Revv process exports to. Grafana
// owns dashboards and trace exploration; the durable archive also powers weekly
// agent reviews. One collector per machine, independent of either Revv channel.

import { join } from "node:path";
import { COLLECTOR_PORT } from "@revv/shared";
import { createCollectorApp } from "./app";
import { TelemetryStore } from "./store";

const DB_PATH = process.env.COLLECTOR_DB_PATH ?? join(import.meta.dir, "..", "collector.duckdb");
const GRAFANA_URL = process.env.COLLECTOR_GRAFANA_URL ?? "http://localhost:3000/d/revv-overview";
const PRUNE_INTERVAL_MS = 5 * 60_000;

const { acquireSingleInstance } = await import("./singleInstance");
const releasePidFile = acquireSingleInstance(`${DB_PATH}.collector.pid`);

const store = await TelemetryStore.open(DB_PATH);

const app = createCollectorApp(store, GRAFANA_URL).listen({
  port: COLLECTOR_PORT,
  hostname: "127.0.0.1",
});

console.error(`[collector] listening on http://localhost:${COLLECTOR_PORT} (db: ${DB_PATH})`);

const pruneTimer = setInterval(() => {
  store.prune().catch((err) => console.error("[collector] prune failed:", err));
}, PRUNE_INTERVAL_MS);
pruneTimer.unref();

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) process.exit(1);
  shuttingDown = true;
  console.error(`[collector] ${signal} received — shutting down…`);
  const hardKill = setTimeout(() => process.exit(1), 5000);
  hardKill.unref();
  try {
    app.stop();
  } catch {}
  clearInterval(pruneTimer);
  store.close();
  releasePidFile();
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
