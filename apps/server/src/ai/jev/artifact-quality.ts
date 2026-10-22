// ── Artifact craft bar ───────────────────────────────────────────────────────
// The `artifact` block variant requires live state, a reader-varied control, and a verdict
// (see `add_diff_step`'s schema). Three nouls turn that contract into a judgment, one per
// clause, so a rejection names what failed.
//
// Blocking, unlike the issue gate: a block that appeared then vanished would leave a hole
// in the chapter's `step_index` sequence, and artifacts are rare enough the latency is fine.

import { noul } from "@typesafe-ai/sdk";
import { Effect } from "effect";
import type { JevState } from "../../services/Jev";
import { JevService } from "../../services/Jev";
import { SettingsService } from "../../services/Settings";
import { optionalJev } from "./optional";

/** Timeout budget; short because it sits on the write path and a slow answer accepts the block. */
export const ARTIFACT_QUALITY_TIMEOUT_MS = 6_000;

/** Character ceiling on the HTML sent to Jev. Generous: the interactive parts (the script) are usually at the bottom, and truncating them would read as no interactivity at all. */
const ARTIFACT_MAX_CHARS = 24_000;

/** Probability below which a clause counts as failed. One threshold, not a composite: the three clauses are conjunctive in the contract. */
export const ARTIFACT_CLAUSE_FLOOR = 0.35;

/** Clauses allowed to fail before rejection. One clause failing is noise in a judgment over generated HTML; two is the signal it isn't an artifact. */
export const ARTIFACT_MAX_FAILED_CLAUSES = 1;

export interface ArtifactVerdict {
  /** Clause keys that fell below the floor, in contract order. */
  readonly failed: readonly string[];
  /** Whether the handler should refuse the block. */
  readonly reject: boolean;
}

const CLAUSES = {
  live_state:
    "`artifact.html` renders a readout of some current state — a value, a count, a status — that the document itself updates, rather than a fixed picture.",
  reader_can_vary:
    "`artifact.html` gives the reader a control that changes what is displayed: an input, a slider, a toggle, a button that advances or recomputes something.",
  reaches_a_verdict:
    "`artifact.html` leads the reader to a conclusion about the code under review — it says what the behaviour means, not only what it is.",
} as const satisfies Record<string, string>;

const CLAUSE_KEYS = ["live_state", "reader_can_vary", "reaches_a_verdict"] as const;

const CLAUSE_LABELS: Record<keyof typeof CLAUSES, string> = {
  live_state: "no live state readout — nothing on screen changes value",
  reader_can_vary: "nothing for the reader to vary — no input, toggle, or control",
  reaches_a_verdict: "no verdict — it shows behaviour without saying what it means",
};

/** Judges one artifact against the craft bar. Never fails; an unavailable Jev accepts the block rather than rejecting it. */
export function judgeArtifact(
  html: string,
  context: { readonly chapterTitle: string; readonly annotation: string | null },
): Effect.Effect<ArtifactVerdict, never, JevService | SettingsService> {
  return Effect.gen(function* () {
    const settingsSvc = yield* SettingsService;
    const settings = yield* settingsSvc.getSettings().pipe(Effect.orElseSucceed(() => null));
    if (settings?.jev.enabled !== true) {
      return { failed: [], reject: false };
    }

    const state: JevState = {
      chapter: context.chapterTitle,
      annotation: context.annotation,
      artifact: { html: html.slice(0, ARTIFACT_MAX_CHARS) },
      contract:
        "An artifact is an interactive widget embedded in a code review. It earns its place only when prose, a code excerpt, or a diff would not do the job.",
    };

    const jev = yield* JevService;
    const result = yield* optionalJev(
      "artifact craft bar",
      jev.ask({
        label: "artifact",
        timeoutMs: ARTIFACT_QUALITY_TIMEOUT_MS,
        state,
        questions: {
          live_state: noul(CLAUSES.live_state),
          reader_can_vary: noul(CLAUSES.reader_can_vary),
          reaches_a_verdict: noul(CLAUSES.reaches_a_verdict),
        },
      }),
    );

    if (result === null) return { failed: [], reject: false };

    const answers = result.answers;
    const failed = CLAUSE_KEYS.filter((key) => {
      const answer: unknown = answers[key];
      // Missing answer counts as pass, not fail (per-clause version of the rule above).
      if (answer === null || typeof answer !== "object" || !("noul" in answer)) return false;
      return typeof answer.noul === "number" && answer.noul < ARTIFACT_CLAUSE_FLOOR;
    });

    return {
      failed: failed.map((key) => CLAUSE_LABELS[key]),
      reject: failed.length > ARTIFACT_MAX_FAILED_CLAUSES,
    };
  });
}

/** Agent-facing rejection text: what failed, and what to do instead. */
export function renderArtifactRejection(verdict: ArtifactVerdict): string {
  return [
    `Error: this artifact does not clear the craft bar — ${verdict.failed.join("; ")}.`,
    "",
    "An artifact has to carry live state, something the reader can vary, and a verdict. A step-reveal with no changing state is a markdown list, and a static picture is a code block.",
    "",
    "Two ways forward, and the second is usually right: find the state that actually changes in this code and build the widget around varying it, or drop the artifact and send the same content as a `markdown` block. A bad artifact is worse than no artifact.",
  ].join("\n");
}
