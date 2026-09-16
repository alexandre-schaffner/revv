// ── prlens-doc ───────────────────────────────────────────────────────────────
//
// Write-time validation for the `prlens` diagram fences an agent embeds in
// markdown blocks and annotations.
//
// The fence body is a PR Lens graph document, validated in the web app by
// `@coldtea/pr-lens-schema` at render time. A document the schema rejects has
// no fallback worth reading: the walkthrough shows a red schema complaint and
// a pretty-printed dump of the JSON where the diagram should be, and by then
// the run is over and the reader is the one who found out.
//
// So the same check runs here, on the write path, against the same package and
// the same wrapper (`toGraphDocInput` in `@revv/shared`). A rejected document
// fails the tool call with the schema's own message, which is a recoverable
// error the agent fixes and retries — the tools are idempotent upserts, so a
// retry of the corrected block is a plain overwrite (CLAUDE.md invariants #3
// and #5).

import { formatIssues, SCHEMA_VERSION, safeParseGraphDoc } from "@coldtea/pr-lens-schema";
import { toGraphDocInput } from "@revv/shared";

/** How much of the schema's complaint survives into the tool result. */
const MAX_ISSUE_TEXT = 600;

/**
 * An opening code fence: up to three spaces of indent, three or more backticks
 * or tildes, then the info string. A backtick fence's info string may not
 * contain a backtick (CommonMark), which is what keeps an inline span from
 * opening a block.
 */
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})[ \t]*(.*)$/;

function isPrLensInfo(info: string): boolean {
  const lang =
    info
      .trim()
      .split(/[\s,{]/, 1)[0]
      ?.toLowerCase() ?? "";
  return lang === "prlens" || lang === "pr-lens";
}

/**
 * Every top-level `prlens` fence body in a markdown source, in document order.
 *
 * Nested fences are deliberately not scanned: a ````markdown block that shows a
 * ```prlens example (as the walkthrough prompt itself does) renders as sample
 * text, never as a diagram, so validating its body would reject writes the
 * reader would never see fail. Skipping to each fence's close — rather than
 * treating every fence line as an opener — is what makes that true.
 */
export function prLensFenceBodies(markdown: string): string[] {
  // `renderMarkdown` normalizes literal `\n` escapes (an AI output artefact)
  // into real newlines before parsing, so a fence written on one escaped line
  // still renders as a fence. Match that here, or the one shape most likely to
  // be malformed is the one shape this never inspects.
  const lines = markdown.replace(/\\n/g, "\n").split("\n");
  const bodies: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const open = FENCE_OPEN.exec(lines[i] ?? "");
    if (!open) continue;

    const marker = open[1] ?? "";
    const info = open[2] ?? "";
    if (marker.startsWith("`") && info.includes("`")) continue;

    const close = new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}[ \\t]*$`);
    let end = i + 1;
    while (end < lines.length && !close.test(lines[end] ?? "")) end++;

    if (isPrLensInfo(info)) bodies.push(lines.slice(i + 1, end).join("\n"));
    // Resume after the close (or at EOF for an unterminated fence), so a fence
    // inside this one is never mistaken for a fence of its own.
    i = end;
  }

  return bodies;
}

/** The schema's verdict on one fence body, or null when it would render. */
function fenceError(body: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    return `not valid JSON (${error instanceof Error ? error.message : "parse failed"})`;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return "not a JSON object — the fence body is a graph document, not an array or a scalar";
  }

  const result = safeParseGraphDoc(
    toGraphDocInput(parsed as Record<string, unknown>, SCHEMA_VERSION),
  );
  if (result.ok) return null;

  const issues = formatIssues(result.error.issues);
  return issues.length <= MAX_ISSUE_TEXT ? issues : `${issues.slice(0, MAX_ISSUE_TEXT - 1)}…`;
}

/**
 * Validate every `prlens` fence in one piece of agent-written markdown.
 * Returns a recoverable error string naming the first rejected diagram, or
 * null when every fence (possibly none) is renderable.
 *
 * `label` names the field for the agent — "markdown block content", "code
 * block annotation" — so a block carrying prose and an annotation says which
 * of the two is broken.
 */
export function prLensDiagramError(markdown: string, label: string): string | null {
  const bodies = prLensFenceBodies(markdown);
  for (const [index, body] of bodies.entries()) {
    const error = fenceError(body);
    if (error === null) continue;
    const which = bodies.length > 1 ? ` (diagram ${index + 1} of ${bodies.length})` : "";
    return `Error: the prlens diagram in ${label}${which} is ${error.startsWith("not ") ? error : `rejected by the schema:\n${error}`}\n\nA rejected document renders as an error box and a JSON dump where the diagram should be, so the block was NOT saved. Fix the document against the diagram contract in your instructions — the enums, the id rules, and the requirement that every lane/node id a reference names is declared in the same document — then retry this call. Dropping the fence and keeping the prose is also a valid fix; the diagram is a supplement, never the explanation itself.`;
  }
  return null;
}
