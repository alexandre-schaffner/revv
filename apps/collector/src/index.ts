// ── Revv telemetry collector ─────────────────────────────────────────────────
//
// Local OTLP archive and query API. Grafana owns dashboards and trace
// exploration. The durable archive also powers weekly agent reviews.
// On COLLECTOR_PORT:
//
//   POST /v1/traces   OTLP/HTTP JSON ingest (every Revv process exports here)
//   GET  /api/*       windowed query endpoints backing the dashboard
//   GET  /            redirect to Grafana
//
// The machine collector can run independently of either Revv channel.

import { join } from "node:path";
import { COLLECTOR_PORT } from "@revv/shared";
import { createCollectorApp } from "./app";
import { TelemetryStore } from "./store";

const DB_PATH = process.env.COLLECTOR_DB_PATH ?? join(import.meta.dir, "..", "collector.duckdb");
const GRAFANA_URL = process.env.COLLECTOR_GRAFANA_URL ?? "http://localhost:3000/d/revv-overview";
const PRUNE_INTERVAL_MS = 5 * 60_000;

// ── Single-instance guard (keyed on the DB path) ─────────────────────────────
const { acquireSingleInstance } = await import("./singleInstance");
const releasePidFile = acquireSingleInstance(`${DB_PATH}.collector.pid`);

const store = await TelemetryStore.open(DB_PATH);

const app = createCollectorApp(store, GRAFANA_URL).listen({
  port: COLLECTOR_PORT,
  hostname: "127.0.0.1",
});

console.error(`[collector] listening on http://localhost:${COLLECTOR_PORT} (db: ${DB_PATH})`);

// ── Periodic retention prune ─────────────────────────────────────────────────
const pruneTimer = setInterval(() => {
  store.prune().catch((err) => console.error("[collector] prune failed:", err));
}, PRUNE_INTERVAL_MS);
pruneTimer.unref();

// ── Graceful shutdown ─────────────────────────────────────────────────────────
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
