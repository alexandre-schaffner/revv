// The tool-input shapes of walkthrough content, shared by the generation
// tools and the chat-edit tools so a change to a shape reaches both. Each tool
// surface still words its own descriptions of the block variants.

import { ISSUE_SEVERITIES, RATING_AXES } from "@revv/shared";
import { z } from "zod";

export const ARTIFACT_HTML_CONTRACT =
  "A complete, self-contained HTML document with inline CSS/JS. Vanilla JS only; no external network/CDN; no localStorage; no timers/randomness. Renders in a sandboxed iframe that auto-sizes. Must carry a live state readout, something the reader can vary, and a verdict — a step-reveal with no changing state is a markdown list, not an artifact. Style with the injected Revv theme variables (`var(--color-*)`, `var(--font-*)`) so it matches the app and follows light/dark — never hardcode colors or font-family; spend the accent on the current state, not on buttons. Keep it under ~320px tall: compact rows, no placeholder rows for content not yet revealed. See 'Interactive artifacts (the craft bar)' in the system prompt for the full contract.";

export const codeBlockSchema = z.object({
  file_path: z.string(),
  start_line: z.coerce.number().int(),
  end_line: z.coerce.number().int(),
  language: z.string(),
  content: z.string(),
  annotation: z.string().nullable(),
});

export const diffBlockSchema = z.object({
  file_path: z.string(),
  patch: z.string(),
  annotation: z.string().nullable(),
});

export const artifactBlockField = z
  .object({
    html: z.string().describe(ARTIFACT_HTML_CONTRACT),
    annotation: z.string().nullable(),
  })
  .nullable()
  .optional()
  .describe(
    "Use for an interactive widget when prose/code/diff fall short. Mutually exclusive with markdown, code, and diff.",
  );

/** A block named by its position, the key `add_diff_step` wrote it under. */
export const blockRefSchema = z.object({
  semantic_step_index: z.coerce
    .number()
    .int()
    .nonnegative()
    .describe("Parent chapter's semantic_step_index."),
  step_index: z.coerce
    .number()
    .int()
    .nonnegative()
    .describe(
      "Atomic block's step_index within the chapter (matches the add_diff_step call you want to reference).",
    ),
});

export const ratingAxisSchema = z.enum(RATING_AXES);

export const verdictSchema = z.enum(["pass", "concern", "blocker"]);

export const confidenceSchema = z.enum(["low", "medium", "high"]);

export const citationSchema = z.object({
  file_path: z.string(),
  start_line: z.coerce.number().int(),
  end_line: z.coerce.number().int(),
  note: z.string().nullable(),
});

export const severitySchema = z.enum(ISSUE_SEVERITIES);

/**
 * When a concern earns an issue, and at what severity. `flag_issue` adds the
 * first-pass leads rule, which only a generation run has.
 */
export function severityCalibration(tool: "flag_issue" | "add_issue"): string {
  const [decide, decided, verb, diff, leads] =
    tool === "flag_issue"
      ? [
          "WHETHER TO FLAG",
          "ONCE FLAGGED",
          "flag",
          "THIS diff",
          ", except for confirmed first-pass leads, which follow the run prompt's First-pass leads rules",
        ]
      : ["WHETHER TO ADD AN ISSUE", "ONCE ADDED", "add", "the reviewed diff", ""];
  return `Two decisions, kept separate. (1) ${decide} — a HIGH bar: ${verb} only if ALL hold — meaningful impact (accuracy/perf/security/maintainability); discrete & actionable with a clear fix; rigor matching the surrounding codebase; introduced by ${diff} (not pre-existing); the author would likely fix it; rests on verifiable facts (no speculation); provably affects specific code (not theoretical); not an intentional design choice. If any fails, do not ${verb}. (2) SEVERITY ${decided} — a LOW bar: DEFAULT TO 'warning'; don't hedge a real finding down to 'info'. 'critical' = blocks release / causes an incident (RCE, hardcoded prod secret, auth bypass, unauthenticated privileged endpoint, data-loss path, broken migration, breaking API change without a shim, race on shared state, crash-on-unhandled-error). 'warning' (the common tier) = address before merge / next cycle (SQLi behind auth, stored XSS, sensitive-data IDOR, CSRF on state change, info disclosure, prompt injection behind auth, very-new dependency, missed edge case, missing test for new behavior, unhandled error path, off-by-one). 'info' = RARE genuine nitpick / low-impact hardening the author can defer — most reviews have zero${leads}. Security examples are illustrative per tier, not a narrowing — correctness/perf/tests/maintainability map the same way.`;
}
