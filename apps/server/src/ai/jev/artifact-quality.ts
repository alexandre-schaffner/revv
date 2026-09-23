// ── Artifact craft bar ───────────────────────────────────────────────────────
//
// The `artifact` block variant carries an explicit, written-down contract —
// "a live state readout, something the reader can vary, and a verdict; a
// step-reveal with no changing state is a markdown list, not an artifact"
// (see `add_diff_step`'s schema and "Interactive artifacts" in the system
// prompt). Until now that contract was checked by string heuristics in
// `withArtifactWarnings`, which could only *warn*.
//
// Three nouls turn it into a judgment the tool can act on. Each maps to one
// clause of the contract, so a rejection names the clause that failed and the
// agent knows what to change.
//
// **Blocking, unlike the issue gate — deliberately.** A gate that rejects has
// to answer before the write, and a block that appeared and then vanished
// would leave a hole in the chapter's `step_index` sequence. The latency
// argument that pushed issues off the critical path doesn't apply: artifacts
// are rare (a couple per walkthrough at most), where concerns are not.

import { Effect } from "effect";
import type { JevState } from "../../services/Jev";
import { JevService } from "../../services/Jev";
import { SettingsService } from "../../services/Settings";
import { optionalJev } from "./optional";
import { noulQuestion } from "./questions";

/** Budget. On the write path, so tight — a slow answer accepts the block. */
export const ARTIFACT_QUALITY_TIMEOUT_MS = 6_000;

/**
 * Character ceiling on the HTML put in state.
 *
 * Generous, because the three questions are about what the document *does*
 * and the interactive parts are usually at the bottom (the script). A
 * head-truncated artifact would read as having no interactivity at all,
 * which is exactly the false positive that would make this gate hated.
 */
const ARTIFACT_MAX_CHARS = 24_000;

/**
 * Probability below which a clause counts as failed.
 *
 * One threshold rather than a composite, because the three clauses are
 * conjunctive in the contract — an artifact with live state and a verdict but
 * nothing to vary is still a diagram, not an artifact.
 */
export const ARTIFACT_CLAUSE_FLOOR = 0.35;

/**
 * How many clauses may fail without the block being rejected.
 *
 * One. A single clause reading low is inside the noise band of a judgment
 * about generated HTML, and a false rejection costs the agent a rewrite of
 * its most expensive block type. Two independent clauses failing is the
 * signal that it isn't an artifact at all.
 */
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

/**
 * Judge one artifact against the craft bar.
 *
 * Never fails, and never rejects on an unavailable Jev: an artifact that
 * would have been accepted before this hook existed must still be accepted
 * when the hook can't answer.
 */
export function judgeArtifact(
  html: string,
  context: { readonly chapterTitle: string; readonly annotation: string | null },
): Effect.Effect<ArtifactVerdict, never, JevService | SettingsService> {
  return Effect.gen(function* () {
    const settingsSvc = yield* SettingsService;
    const settings = yield* settingsSvc.getSettings().pipe(Effect.orElseSucceed(() => null));
    if (settings?.jev.artifactQuality !== true) {
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
          live_state: noulQuestion(CLAUSES.live_state),
          reader_can_vary: noulQuestion(CLAUSES.reader_can_vary),
          reaches_a_verdict: noulQuestion(CLAUSES.reaches_a_verdict),
        },
      }),
    );

    if (result === null) return { failed: [], reject: false };

    const answers = result.answers;
    const failed = CLAUSE_KEYS.filter((key) => {
      const answer: unknown = answers[key];
      // A missing answer is not a failure — see the "never rejects on
      // unavailable" rule above, applied per clause.
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
