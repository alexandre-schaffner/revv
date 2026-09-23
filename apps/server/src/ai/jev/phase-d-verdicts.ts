// ── Phase-D verdict pass ─────────────────────────────────────────────────────
//
// Fired by the orchestrator once Phase C commits: nine `pass | concern |
// blocker` judgments over the finished review, written as nine pre-seeded
// `walkthrough_ratings` rows. `rate_axis` then supplies prose only.
//
// The pass ALWAYS terminates `walkthroughs.axis_advisory_state` — `'ready'`
// on success, `'unavailable'` on every other outcome including the feature
// being switched off. That is load-bearing: `rate_axis` treats `'pending'` as
// a retryable "try again in a moment", so a pass that could leave the column
// pending would wedge the agent until its budget ran out.

import type { RatingAxis, Verdict } from "@revv/shared";
import { RATING_AXES, RATING_AXIS_LABELS } from "@revv/shared";
import type { ChoiceQuestion } from "@typesafe-ai/sdk";
import { and, asc, eq } from "drizzle-orm";
import { Effect } from "effect";
import type { Db } from "../../db";
import { prDiffFiles } from "../../db/schema/pr-diff-files";
import { pullRequests } from "../../db/schema/pull-requests";
import { walkthroughBlocks } from "../../db/schema/walkthrough-blocks";
import { walkthroughIssues } from "../../db/schema/walkthrough-issues";
import { walkthroughRatings } from "../../db/schema/walkthrough-ratings";
import { walkthroughSemanticSteps } from "../../db/schema/walkthrough-semantic-steps";
import { walkthroughs } from "../../db/schema/walkthroughs";
import { debug } from "../../logger";
import { JevService } from "../../services/Jev";
import { SettingsService } from "../../services/Settings";
import { optionalJev } from "./optional";
import { buildPhaseCState } from "./state";

/**
 * Budget for the pass. Longer than the job-start ceiling because nothing is
 * blocked on a mutex here — only `rate_axis`, which retries. Still bounded:
 * the agent is sitting in a retry loop the whole time.
 */
export const PHASE_D_TIMEOUT_MS = 10_000;

/**
 * Per-axis criteria, lifted verbatim from the "Ratings (the 9-axis
 * scorecard — Phase D)" section of `ai/prompts/walkthrough-system-common.md`
 * so the question the orchestrator asks and the rubric the agent writes to
 * can't drift apart.
 */
const AXIS_SUBJECT: Readonly<Record<RatingAxis, string>> = {
  correctness: "logic errors, off-by-ones, wrong conditionals, races, unhandled errors",
  scope:
    "whether the PR does one thing, or has absorbed drive-by refactors and unrelated changes — several unrelated concerns is at least a concern",
  tests: "whether new behavior has tests, and whether any assertions were deleted or weakened",
  clarity: "naming, function length, nesting, comments, dead code, magic numbers",
  safety:
    "whether it touches auth, payments, migrations, deletes, public APIs, or shared packages. This is a risk-surface signal, not a quality score — a clean migration is still high risk",
  consistency: "whether it follows the existing codebase's patterns, layering, and conventions",
  api_changes: "breaking changes to routes, schemas, event payloads, or exported types",
  performance: "N+1 queries, unbounded loops, synchronous work in hot paths, missing indexes",
  description:
    "whether the pull request description explains *why*, links issues, and calls out deployment concerns",
};

const VERDICT_CRITERIA = {
  pass: "No meaningful concern on this axis, including when the axis simply does not apply to this pull request.",
  concern: "Something on this axis should be addressed before merging.",
  blocker: "Do not merge until this is fixed.",
} as const;

/** Map the calibrated confidence onto the three-level enum the schema stores. */
export function confidenceBucket(confidence: number): "low" | "medium" | "high" {
  if (confidence >= 0.8) return "high";
  if (confidence >= 0.5) return "medium";
  return "low";
}

type AxisQuestionKey = `axis_${RatingAxis}`;

function questionKey(axis: RatingAxis): AxisQuestionKey {
  return `axis_${axis}`;
}

function axisQuestion(axis: RatingAxis): ChoiceQuestion<typeof VERDICT_CRITERIA> {
  return {
    type: "choice",
    instructions: {
      axis: RATING_AXIS_LABELS[axis],
      judge: `Considering ${AXIS_SUBJECT[axis]}, what verdict does this pull request earn on the ${RATING_AXIS_LABELS[axis]} axis?`,
      // Without this the model reads `review` as the only evidence and can
      // only echo what a chapter happened to mention. The file list is what
      // makes "412 added lines, zero test files touched" visible.
      note: "`review` is a completed code review of the change; `changed_files` lists every file the pull request touches with its line counts. Weigh both.",
    },
    criteria: VERDICT_CRITERIA,
  };
}

const AXIS_QUESTIONS = {
  axis_correctness: axisQuestion("correctness"),
  axis_scope: axisQuestion("scope"),
  axis_tests: axisQuestion("tests"),
  axis_clarity: axisQuestion("clarity"),
  axis_safety: axisQuestion("safety"),
  axis_consistency: axisQuestion("consistency"),
  axis_api_changes: axisQuestion("api_changes"),
  axis_performance: axisQuestion("performance"),
  axis_description: axisQuestion("description"),
} satisfies Record<AxisQuestionKey, ChoiceQuestion<typeof VERDICT_CRITERIA>>;

/** Gather everything `buildPhaseCState` needs, in one pass over the DB. */
function collectPhaseCInput(db: Db, walkthroughId: string) {
  const row = db.select().from(walkthroughs).where(eq(walkthroughs.id, walkthroughId)).get();
  if (!row) return null;
  const pr = db.select().from(pullRequests).where(eq(pullRequests.id, row.pullRequestId)).get();
  if (!pr) return null;

  const files = db
    .select({
      filename: prDiffFiles.path,
      status: prDiffFiles.status,
      additions: prDiffFiles.additions,
      deletions: prDiffFiles.deletions,
    })
    .from(prDiffFiles)
    .where(eq(prDiffFiles.prId, row.pullRequestId))
    .all();

  const chapters = db
    .select({
      semanticStepIndex: walkthroughSemanticSteps.semanticStepIndex,
      title: walkthroughSemanticSteps.title,
    })
    .from(walkthroughSemanticSteps)
    .where(eq(walkthroughSemanticSteps.walkthroughId, walkthroughId))
    .orderBy(asc(walkthroughSemanticSteps.semanticStepIndex))
    .all();

  const blockCounts = new Map<number, number>();
  for (const block of db
    .select({ semanticStepIndex: walkthroughBlocks.semanticStepIndex })
    .from(walkthroughBlocks)
    .where(
      and(
        eq(walkthroughBlocks.walkthroughId, walkthroughId),
        eq(walkthroughBlocks.phase, "diff_analysis"),
      ),
    )
    .all()) {
    blockCounts.set(block.semanticStepIndex, (blockCounts.get(block.semanticStepIndex) ?? 0) + 1);
  }

  const issues = db
    .select({
      id: walkthroughIssues.id,
      severity: walkthroughIssues.severity,
      title: walkthroughIssues.title,
      description: walkthroughIssues.description,
      filePath: walkthroughIssues.filePath,
    })
    .from(walkthroughIssues)
    .where(eq(walkthroughIssues.walkthroughId, walkthroughId))
    .orderBy(asc(walkthroughIssues.order))
    .all();

  return {
    pr,
    files,
    summary: row.summary,
    sentiment: row.sentiment ?? "",
    chapters: chapters.map((c) => ({
      title: c.title,
      stepCount: blockCounts.get(c.semanticStepIndex) ?? 0,
    })),
    issues,
  };
}

/**
 * Clear a stranded `'pending'`, restoring the pre-TypeSafe contract. Called
 * when the pass crashes outright and by `resumePending()` for rows left
 * mid-pass by a `kill -9`. Conditional on the column still being `'pending'`,
 * so it can never walk back a `'ready'` the pass already committed.
 */
export function markAxisAdvisoryUnavailable(db: Db, walkthroughId: string): void {
  setState(db, walkthroughId, "unavailable");
}

function setState(db: Db, walkthroughId: string, state: "ready" | "unavailable"): void {
  db.update(walkthroughs)
    .set({ axisAdvisoryState: state })
    .where(and(eq(walkthroughs.id, walkthroughId), eq(walkthroughs.axisAdvisoryState, "pending")))
    .run();
}

/**
 * Run the verdict pass for one walkthrough.
 *
 * Never fails: every error path lands on `'unavailable'`, which restores the
 * pre-TypeSafe contract where the agent supplies its own verdicts. Safe to
 * call when the feature is off — that's the fast path to `'unavailable'`,
 * and it is how the `'pending'` written inside the Phase C transaction gets
 * cleared on a machine that never had a key.
 */
export function runAxisVerdictPass(
  db: Db,
  walkthroughId: string,
): Effect.Effect<void, never, JevService | SettingsService> {
  return Effect.gen(function* () {
    // Idempotence gate, and the reason `resumePending()` can fire this
    // unconditionally for every generating row: only a row actually waiting
    // on the pass does any work, so a resume neither re-asks for a
    // walkthrough that already has its verdicts nor walks one back.
    const pending = yield* Effect.sync(
      () =>
        db
          .select({ state: walkthroughs.axisAdvisoryState })
          .from(walkthroughs)
          .where(eq(walkthroughs.id, walkthroughId))
          .get()?.state === "pending",
    );
    if (!pending) return;

    const settingsSvc = yield* SettingsService;
    const settings = yield* settingsSvc.getSettings().pipe(Effect.orElseSucceed(() => null));
    const enabled = settings?.jev.verdicts === true;

    if (!enabled) {
      yield* Effect.sync(() => setState(db, walkthroughId, "unavailable"));
      return;
    }

    const input = yield* Effect.sync(() => collectPhaseCInput(db, walkthroughId));
    if (input === null) {
      yield* Effect.sync(() => setState(db, walkthroughId, "unavailable"));
      return;
    }

    const jev = yield* JevService;
    const result = yield* optionalJev(
      `axis verdict pass for ${walkthroughId}`,
      jev.ask({
        label: "phase-c",
        timeoutMs: PHASE_D_TIMEOUT_MS,
        state: buildPhaseCState(input),
        questions: AXIS_QUESTIONS,
      }),
    );

    if (result === null) {
      yield* Effect.sync(() => setState(db, walkthroughId, "unavailable"));
      return;
    }

    const answers = result.answers;
    yield* Effect.sync(() => {
      const now = new Date().toISOString();
      db.transaction(() => {
        // Re-read under the transaction: a resume may have already moved the
        // column on, and seeding over rows the agent has started writing
        // would erase its prose.
        const current = db
          .select({ state: walkthroughs.axisAdvisoryState })
          .from(walkthroughs)
          .where(eq(walkthroughs.id, walkthroughId))
          .get();
        if (current?.state !== "pending") return;

        for (const axis of RATING_AXES) {
          const answer = answers[questionKey(axis)];
          if (!answer) continue;
          const verdict: Verdict = answer.choice;
          db.insert(walkthroughRatings)
            .values({
              id: crypto.randomUUID(),
              walkthroughId,
              axis,
              verdict,
              confidence: confidenceBucket(answer.confidence),
              // Empty by design: a non-empty rationale is what marks an axis
              // as done for the phase-D counter, so a seeded row must not
              // look finished.
              rationale: "",
              details: "",
              citations: "[]",
              blockIds: "[]",
              verdictSource: "advisory",
              verdictConfidence: answer.confidence,
              createdAt: now,
            })
            .onConflictDoUpdate({
              target: [walkthroughRatings.walkthroughId, walkthroughRatings.axis],
              set: {
                verdict,
                confidence: confidenceBucket(answer.confidence),
                verdictSource: "advisory",
                verdictConfidence: answer.confidence,
              },
            })
            .run();
        }
        db.update(walkthroughs)
          .set({ axisAdvisoryState: "ready" })
          .where(eq(walkthroughs.id, walkthroughId))
          .run();
      });
    });
    debug("jev", `axis verdicts ready for ${walkthroughId}`);
  });
}
