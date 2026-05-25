// Public surface of the observability module. Importers should only ever
// touch this file — never reach into ./tracer, ./metrics, ./logger directly.

export { logger, setMinimumLogLevel } from "./logger";
export { recordCounter, recordHistogram, snapshot } from "./metrics";
export {
  type SpanHandle,
  startSpan,
  traced,
  tracedAsync,
  tracedAsyncWith,
  tracedDerived,
  tracedEffect,
} from "./perf";
export { initObservability } from "./runtime";
export {
  type CompletedSpan,
  isVerbose,
  readSpans,
  type SpanSummary,
  setVerbose,
  summarizeSpans,
} from "./tracer";
