import type { CheckDetails, CheckLogLine } from "@revv/shared";

const LOG_TAIL_LINES = 150;

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes are control characters by definition
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const TIMESTAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z ?/;

function classify(line: string): CheckLogLine | null {
  if (line.startsWith("##[endgroup]")) return null;
  if (line.startsWith("##[error]")) return { kind: "error", text: line.slice(9) };
  if (line.startsWith("##[warning]")) return { kind: "warning", text: line.slice(11) };
  if (line.startsWith("##[group]")) return { kind: "group", text: line.slice(9) };
  return { kind: "plain", text: line };
}

/**
 * The part of an Actions job log a reviewer needs: the step that failed.
 *
 * A job log is every step back to back, each opening with a `##[group]`
 * header (`Run npm test`, `Set up job`, …). The failing step is the one
 * holding the first `##[error]`; later steps are skipped or cleanup. That
 * step is returned, trimmed to its last {@link LOG_TAIL_LINES} lines (the
 * error is at the end). With no error marker, the log's tail stands in.
 */
export function extractLogTail(log: string): NonNullable<CheckDetails["log"]> {
  const lines = log
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((l) => l.replace(TIMESTAMP, "").replace(ANSI, ""));
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const isStepHeader = (l: string) => l.startsWith("##[group]Run ") || l === "##[group]Run";
  const firstError = lines.findIndex((l) => l.startsWith("##[error]"));

  let start = 0;
  let end = lines.length;
  let stepName: string | null = null;
  if (firstError >= 0) {
    for (let i = firstError; i >= 0; i--) {
      const l = lines[i] ?? "";
      if (isStepHeader(l)) {
        start = i;
        stepName = l.slice("##[group]".length);
        break;
      }
    }
    for (let i = firstError + 1; i < lines.length; i++) {
      const l = lines[i] ?? "";
      // The next step, or the post-job cleanup that follows the last one
      // (GitHub opens it with a bare "Post job cleanup." line).
      if (isStepHeader(l) || l.startsWith("##[group]Post ") || l.startsWith("Post job cleanup")) {
        end = i;
        break;
      }
    }
  }

  const step = lines.slice(start, end);
  const truncated = step.length > LOG_TAIL_LINES;
  const tail = truncated ? step.slice(-LOG_TAIL_LINES) : step;
  return {
    stepName,
    lines: tail.map(classify).filter((l): l is CheckLogLine => l !== null),
    truncated,
  };
}
