// ── Structured logger ───────────────────────────────────────────────────────

const consoleFns = {
  debug: console.debug.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
} as const;

type Level = keyof typeof consoleFns;

const levels: Level[] = ["debug", "info", "warn", "error"];

let minLevelIdx = 1; // "info"

export function setMinimumLogLevel(level: "debug" | "info" | "warn" | "error"): void {
  minLevelIdx = levels.indexOf(level);
}

export function getMinimumLogLevel(): string {
  return levels[minLevelIdx] ?? "info";
}

type LogFn = (msg: string, extras?: Record<string, unknown>) => void;

interface LoggerSurface {
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  scoped: (scope: string) => Omit<LoggerSurface, "scoped">;
}

function makeLogFn(level: Level, prefix?: string): LogFn {
  return (msg, extras) => {
    if (levels.indexOf(level) < minLevelIdx) return;
    const tag = prefix ? `[obs:${prefix}]` : "[obs]";
    if (extras && Object.keys(extras).length > 0) {
      consoleFns[level](tag, msg, extras);
    } else {
      consoleFns[level](tag, msg);
    }
  };
}

export const logger: LoggerSurface = {
  debug: makeLogFn("debug"),
  info: makeLogFn("info"),
  warn: makeLogFn("warn"),
  error: makeLogFn("error"),
  scoped: (scope) => ({
    debug: makeLogFn("debug", scope),
    info: makeLogFn("info", scope),
    warn: makeLogFn("warn", scope),
    error: makeLogFn("error", scope),
  }),
};
