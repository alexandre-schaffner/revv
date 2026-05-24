// ── Observability runtime bootstrap ─────────────────────────────────────────
//
// Imported once from the root layout. Installs `window.__revv` in dev for
// ad-hoc DevTools inspection and arms a periodic metric dumper when verbose
// mode is on. Idempotent — multiple imports are no-ops past the first.

import { getMinimumLogLevel, logger, setMinimumLogLevel } from "./logger";
import { clearMetrics, snapshot } from "./metrics";
import {
  type CompletedSpan,
  clearSpans,
  isVerbose,
  readSpans,
  type SpanSummary,
  setVerbose,
  summarizeSpans,
} from "./tracer";

interface RevvObsGlobal {
  /** Read the in-memory ring buffer (chronological). */
  spans: (filter?: { name?: string | RegExp; minDurationMs?: number }) => CompletedSpan[];
  /** Group + summarize spans by name. The "what dominated?" function. */
  spansByName: () => Record<string, SpanSummary>;
  /** Current metric snapshot — counters + histograms. */
  metrics: () => ReturnType<typeof snapshot>;
  /** Print metrics with `console.table`. */
  printMetrics: () => void;
  /** Print top-N slowest spans by p95, descending. */
  printTopSpans: (n?: number) => void;
  /** Flip verbose-console mode at runtime. Persists in localStorage. */
  setVerbose: (value: boolean) => void;
  isVerbose: () => boolean;
  /** Adjust the logger's minimum level live. */
  setLogLevel: (level: "debug" | "info" | "warn" | "error") => void;
  getLogLevel: () => string;
  /** Reset ring buffer + metric snapshot for clean re-measurement. */
  clear: () => void;
}

let installed = false;
let dumperInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Install the `window.__revv` DevTools surface and start a periodic metric
 * dump if verbose. Safe to call multiple times — only the first call has
 * effect.
 */
export function initObservability(): void {
  if (installed) return;
  installed = true;

  if (typeof window === "undefined") return;

  const api: RevvObsGlobal = {
    spans: (filter) => readSpans(filter),
    spansByName: () => summarizeSpans(),
    metrics: () => snapshot(),
    printMetrics: () => {
      const s = snapshot();
      console.group("[obs] metrics");
      if (Object.keys(s.counters).length > 0) {
        console.log("counters:");
        console.table(s.counters);
      }
      if (Object.keys(s.histograms).length > 0) {
        console.log("histograms:");
        console.table(s.histograms);
      }
      console.groupEnd();
    },
    printTopSpans: (n = 20) => {
      const grouped = summarizeSpans();
      const rows = Object.entries(grouped)
        .map(([name, v]) => ({ name, ...v }))
        .sort((a, b) => b.p95 - a.p95)
        .slice(0, n);
      console.table(rows);
    },
    setVerbose: (value) => {
      setVerbose(value);
      logger.info("verbose mode toggled", { verbose: value });
      maybeArmDumper();
    },
    isVerbose: () => isVerbose(),
    setLogLevel: (level) => {
      setMinimumLogLevel(level);
      logger.info("log level changed", { level });
    },
    getLogLevel: () => getMinimumLogLevel(),
    clear: () => {
      clearSpans();
      clearMetrics();
      logger.info("observability state cleared");
    },
  };

  // Attach to window (dev: for typing convenience, production: still attached
  // since the bundle includes it — guard at the layout level if we want to
  // strip in prod builds. The cost is one global pointer.).
  (window as unknown as { __revv?: RevvObsGlobal }).__revv = api;

  maybeArmDumper();

  logger.info("observability initialised", {
    verbose: isVerbose(),
    logLevel: getMinimumLogLevel(),
  });
}

/** When verbose is on, dump a compact metrics summary every 30s. */
function maybeArmDumper(): void {
  if (typeof window === "undefined") return;
  if (isVerbose()) {
    if (dumperInterval) return;
    dumperInterval = setInterval(() => {
      const s = snapshot();
      const hasData = Object.keys(s.counters).length > 0 || Object.keys(s.histograms).length > 0;
      if (!hasData) return;
      console.groupCollapsed("[obs] periodic snapshot");
      if (Object.keys(s.counters).length > 0) console.table(s.counters);
      if (Object.keys(s.histograms).length > 0) console.table(s.histograms);
      console.groupEnd();
    }, 30_000);
  } else if (dumperInterval) {
    clearInterval(dumperInterval);
    dumperInterval = null;
  }
}
