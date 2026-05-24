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
  // Level filtering is owned by `runLog`'s early-out — no duplicate check here.
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

type LogFn = (msg: string, extras?: Record<string, unknown>) => void;

function bind(level: LogLevel.LogLevel, scope?: string): LogFn {
  return (msg, extras) => runLog(level, msg, scope ? { ...extras, scope } : extras);
}

interface LoggerSurface {
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  scoped: (scope: string) => Omit<LoggerSurface, "scoped">;
}

/** Thin Effect-backed logger surface for plain TS/Svelte code. */
export const logger: LoggerSurface = {
  debug: bind(LogLevel.Debug),
  info: bind(LogLevel.Info),
  warn: bind(LogLevel.Warning),
  error: bind(LogLevel.Error),
  scoped: (scope) => ({
    debug: bind(LogLevel.Debug, scope),
    info: bind(LogLevel.Info, scope),
    warn: bind(LogLevel.Warning, scope),
    error: bind(LogLevel.Error, scope),
  }),
};

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
