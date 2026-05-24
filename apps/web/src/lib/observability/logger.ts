// ── Structured logger ───────────────────────────────────────────────────────
//
// Effect-based logger that emits annotated records via `console.*`. Routed
// through an Effect `Logger` + `ManagedRuntime` so callers get the usual
// log-annotation behavior (`Effect.annotateLogs("scope", "wt-trace")` etc.)
// when running inside Effect, and a simple `logger.debug/info/...` surface
// for plain Svelte/TS code.

import { Cause, Effect, FiberId, HashMap, Layer, Logger, LogLevel, ManagedRuntime } from "effect";

const consoleByLevel: Record<string, (...args: unknown[]) => void> = {
  TRACE: console.debug.bind(console),
  DEBUG: console.debug.bind(console),
  INFO: console.info.bind(console),
  WARN: console.warn.bind(console),
  ERROR: console.error.bind(console),
  FATAL: console.error.bind(console),
};

let minLevel: LogLevel.LogLevel = LogLevel.Info;

export function setMinimumLogLevel(level: "debug" | "info" | "warn" | "error"): void {
  switch (level) {
    case "debug":
      minLevel = LogLevel.Debug;
      break;
    case "info":
      minLevel = LogLevel.Info;
      break;
    case "warn":
      minLevel = LogLevel.Warning;
      break;
    case "error":
      minLevel = LogLevel.Error;
      break;
  }
}

export function getMinimumLogLevel(): string {
  return minLevel.label.toLowerCase();
}

const consoleLogger = Logger.make((options) => {
  if (LogLevel.lessThan(options.logLevel, minLevel)) return;

  const scope = HashMap.get(options.annotations, "scope");
  const tag = HashMap.get(options.annotations, "tag");
  const scopeStr = scope._tag === "Some" ? String(scope.value) : null;
  const tagStr = tag._tag === "Some" ? String(tag.value) : null;
  const prefix = scopeStr ? `[obs:${scopeStr}]` : tagStr ? `[${tagStr}]` : "[obs]";

  const out = consoleByLevel[options.logLevel.label] ?? console.log.bind(console);
  const message = Array.isArray(options.message) ? options.message : [options.message];

  const extras: Record<string, unknown> = {};
  HashMap.forEach(options.annotations, (value, key) => {
    if (key === "scope" || key === "tag") return;
    extras[key] = value;
  });
  if (options.cause && !Cause.isEmpty(options.cause)) {
    extras["cause"] = Cause.pretty(options.cause);
  }
  if (FiberId.isFiberId(options.fiberId) && FiberId.threadName(options.fiberId) !== "#0") {
    extras["fiberId"] = FiberId.threadName(options.fiberId);
  }

  if (Object.keys(extras).length > 0) {
    out(prefix, ...message, extras);
  } else {
    out(prefix, ...message);
  }
});

const LoggerLayer = Logger.replace(Logger.defaultLogger, consoleLogger);

/**
 * Singleton Effect runtime hosting the observability `Logger`. Exposed for
 * call sites that want to run an `Effect` (e.g. async wrappers) under the
 * same runtime — plain log calls go through {@link logger} directly.
 */
export const obsRuntime = ManagedRuntime.make(Layer.mergeAll(LoggerLayer));

/** Thin Effect-backed logger surface for plain TS/Svelte code. */
export const logger = {
  debug(msg: string, extras?: Record<string, unknown>): void {
    runLog(LogLevel.Debug, msg, extras);
  },
  info(msg: string, extras?: Record<string, unknown>): void {
    runLog(LogLevel.Info, msg, extras);
  },
  warn(msg: string, extras?: Record<string, unknown>): void {
    runLog(LogLevel.Warning, msg, extras);
  },
  error(msg: string, extras?: Record<string, unknown>): void {
    runLog(LogLevel.Error, msg, extras);
  },
  /** Returns a child logger that auto-annotates every record with `scope=…`. */
  scoped(scope: string): {
    debug: (msg: string, extras?: Record<string, unknown>) => void;
    info: (msg: string, extras?: Record<string, unknown>) => void;
    warn: (msg: string, extras?: Record<string, unknown>) => void;
    error: (msg: string, extras?: Record<string, unknown>) => void;
  } {
    return {
      debug: (msg, extras) => runLog(LogLevel.Debug, msg, { ...extras, scope }),
      info: (msg, extras) => runLog(LogLevel.Info, msg, { ...extras, scope }),
      warn: (msg, extras) => runLog(LogLevel.Warning, msg, { ...extras, scope }),
      error: (msg, extras) => runLog(LogLevel.Error, msg, { ...extras, scope }),
    };
  },
} as const;

function runLog(
  level: LogLevel.LogLevel,
  msg: string,
  extras: Record<string, unknown> | undefined,
): void {
  // Early-out: cheaper than building the Effect when we'd just filter it out.
  if (LogLevel.lessThan(level, minLevel)) return;
  let eff = Effect.logWithLevel(level, msg);
  if (extras) {
    for (const k of Object.keys(extras)) {
      eff = eff.pipe(Effect.annotateLogs(k, formatAnnotation(extras[k])));
    }
  }
  obsRuntime.runSync(eff);
}

function formatAnnotation(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return "[unserializable]";
  }
}
