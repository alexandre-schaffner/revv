// ── Issue scoring ────────────────────────────────────────────────────────────
//
// Five judgments per flagged issue, in one request, after the walkthrough is
// already complete. They collapse into a single composite on
// `walkthrough_issues.advisory_score`, which the DTO turns back into a
// `lowSignal` flag. One column rather than five so the flag survives a
// reload without the UI having to re-derive it from judgments it never saw.
//
// Never runs on a cache-imported walkthrough: that snapshot was scored
// upstream, and re-scoring it would produce a divergent second score set for
// something meant to be reproducible.

import { isLowSignalScore } from "@revv/shared";
import type { NoulQuestion, ScoreQuestion } from "@typesafe-ai/sdk";
import { asc, eq } from "drizzle-orm";
import { Effect } from "effect";
import type { Db } from "../../db";
import { prDiffFiles } from "../../db/schema/pr-diff-files";
import { pullRequests } from "../../db/schema/pull-requests";
import { walkthroughIssues } from "../../db/schema/walkthrough-issues";
import { walkthroughs } from "../../db/schema/walkthroughs";
import { debug } from "../../logger";
import { fitAnchorToPatch } from "../../services/diff-anchors";
import { JevService } from "../../services/Jev";
import { SettingsService } from "../../services/Settings";
import { buildIssueScoringState } from "./state";

/** Budget for the pass. Nothing is waiting on it — the walkthrough is done. */
export const ISSUE_SCORING_TIMEOUT_MS = 20_000;

/**
 * Composite weights.
 *
 * `grounded` dominates because it is the only question that can catch a
 * confidently-wrong claim, and it is the reason the diff hunk has to be in
 * state at all — without the code an issue cites, "is this supported" decays
 * into "does this sound plausible". `in_scope` is next because pre-existing
 * code the diff merely touches is the largest real slop category.
 */
const WEIGHTS = {
  grounded: 0.4,
  in_scope: 0.25,
  actionable: 0.2,
  novel: 0.15,
} as const;

/** Severity rubric, low to high. Index 3 is the "never hide this" level. */
const SEVERITY_LEVELS = [
  "A nit: style, taste, or a preference the author could reasonably decline.",
  "Worth knowing: useful context or a minor improvement, but merging without it is fine.",
  "Should fix before merge: a real defect or risk, though not one that would stop a release.",
  "Must fix: merging this as-is would cause an incident, lose data, or break users.",
] as const;

const MUST_FIX_LEVEL = SEVERITY_LEVELS.length - 1;

export interface IssueScore {
  readonly issueId: string;
  readonly score: number;
  readonly lowSignal: boolean;
}

function noul(instructions: string): NoulQuestion {
  return { type: "noul", instructions };
}

function severityQuestion(issueId: string): ScoreQuestion<typeof SEVERITY_LEVELS> {
  return {
    type: "score",
    instructions: `How consequential is the problem described in \`issues.${issueId}\`?`,
    criteria: SEVERITY_LEVELS,
  };
}

/** Question keys are `<judgment>__<issueId>`; issue ids are UUIDs, so unique. */
function key(judgment: string, issueId: string): string {
  return `${judgment}__${issueId}`;
}

/**
 * Collapse the four nouls into one number, then apply the severity floor.
 *
 * A "must fix" issue is never allowed below the low-signal threshold, and
 * neither is one the agent marked `critical`. The blast radius is asymmetric:
 * a visible weak issue costs a line of screen space, a hidden real bug costs
 * the review. Encoded in the stored composite rather than applied at render
 * time so the floor survives a reload.
 */
export function compositeScore(input: {
  readonly grounded: number;
  readonly in_scope: number;
  readonly actionable: number;
  readonly novel: number;
  readonly severity: number;
  readonly declaredSeverity: string;
}): number {
  const weighted =
    WEIGHTS.grounded * input.grounded +
    WEIGHTS.in_scope * input.in_scope +
    WEIGHTS.actionable * input.actionable +
    WEIGHTS.novel * input.novel;
  const protectedIssue =
    input.declaredSeverity === "critical" || input.severity >= MUST_FIX_LEVEL - 0.5;
  return protectedIssue ? Math.max(weighted, 1) : weighted;
}

/** Load issues with the diff hunk each is anchored to. */
function collectIssues(db: Db, walkthroughId: string) {
  const row = db
    .select({ pullRequestId: walkthroughs.pullRequestId })
    .from(walkthroughs)
    .where(eq(walkthroughs.id, walkthroughId))
    .get();
  if (!row) return null;
  const pr = db.select().from(pullRequests).where(eq(pullRequests.id, row.pullRequestId)).get();
  if (!pr) return null;

  const patchByPath = new Map<string, string | null>();
  for (const file of db
    .select({ path: prDiffFiles.path, patch: prDiffFiles.patch })
    .from(prDiffFiles)
    .where(eq(prDiffFiles.prId, row.pullRequestId))
    .all()) {
    patchByPath.set(file.path, file.patch);
  }

  const issues = db
    .select()
    .from(walkthroughIssues)
    .where(eq(walkthroughIssues.walkthroughId, walkthroughId))
    .orderBy(asc(walkthroughIssues.order))
    .all();

  return { pr, issues, patchByPath };
}

/**
 * The cached patch for an issue's file, or `null` when the issue's line range
 * isn't in the diff at all. `fitAnchorToPatch` returning `ok: false` is a free
 * grounding pre-filter — an issue pointing at lines this PR never touched is
 * by construction about pre-existing code.
 */
function hunkFor(
  patchByPath: Map<string, string | null>,
  issue: { filePath: string | null; startLine: number | null; endLine: number | null },
): { readonly hunk: string | null; readonly offDiff: boolean } {
  if (issue.filePath === null) return { hunk: null, offDiff: false };
  const patch = patchByPath.get(issue.filePath) ?? null;
  if (patch === null) return { hunk: null, offDiff: false };
  if (issue.startLine === null) return { hunk: patch, offDiff: false };
  const fit = fitAnchorToPatch(patch, {
    startLine: issue.startLine,
    endLine: issue.endLine ?? issue.startLine,
    side: "RIGHT",
  });
  return { hunk: patch, offDiff: !fit.ok };
}

/**
 * Score every issue on a completed walkthrough.
 *
 * Never fails — an unavailable Jev leaves every issue unscored, and unscored
 * is never low-signal, so the UI degrades to showing everything. Returns the
 * scores it wrote so the caller can broadcast them.
 */
export function scoreIssues(
  db: Db,
  walkthroughId: string,
): Effect.Effect<readonly IssueScore[], never, JevService | SettingsService> {
  return Effect.gen(function* () {
    const settingsSvc = yield* SettingsService;
    const settings = yield* settingsSvc.getSettings().pipe(Effect.orElseSucceed(() => null));
    if (settings?.jev.enabled !== true || settings.jev.issueScoring !== true) return [];

    const collected = yield* Effect.sync(() => collectIssues(db, walkthroughId));
    if (collected === null || collected.issues.length === 0) return [];

    const anchored = collected.issues.map((issue) => ({
      issue,
      ...hunkFor(collected.patchByPath, issue),
    }));

    const jev = yield* JevService;
    const questions: Record<string, NoulQuestion | ScoreQuestion<typeof SEVERITY_LEVELS>> = {};
    for (const { issue } of anchored) {
      questions[key("grounded", issue.id)] = noul(
        `The claim in \`issues.${issue.id}\` is supported by the code in \`issues.${issue.id}.hunk\`.`,
      );
      questions[key("in_scope", issue.id)] = noul(
        `\`issues.${issue.id}\` is about a change this pull request makes, rather than pre-existing code the diff happens to touch.`,
      );
      questions[key("actionable", issue.id)] = noul(
        `\`issues.${issue.id}\` names a specific change a developer could make.`,
      );
      questions[key("novel", issue.id)] = noul(
        `\`issues.${issue.id}\` tells the reader something they would not already get from reading the diff.`,
      );
      questions[key("severity", issue.id)] = severityQuestion(issue.id);
    }

    const result = yield* jev
      .ask({
        label: "issues",
        timeoutMs: ISSUE_SCORING_TIMEOUT_MS,
        state: buildIssueScoringState({
          pr: collected.pr,
          issues: anchored.map(({ issue, hunk }) => ({
            id: issue.id,
            severity: issue.severity,
            title: issue.title,
            description: issue.description,
            filePath: issue.filePath,
            startLine: issue.startLine,
            endLine: issue.endLine,
            hunk,
          })),
        }),
        questions,
      })
      .pipe(Effect.either);

    if (result._tag === "Left") {
      debug(
        "jev",
        `issue scoring unavailable for ${walkthroughId} (${result.left.reason}) — issues stay unscored`,
      );
      return [];
    }

    const answers = result.right.answers;
    const readNoul = (judgment: string, issueId: string): number | null => {
      const answer = answers[key(judgment, issueId)];
      return answer !== undefined && answer.type === "noul" ? answer.noul : null;
    };

    const scores: IssueScore[] = [];
    for (const { issue, offDiff } of anchored) {
      const grounded = readNoul("grounded", issue.id);
      const inScope = readNoul("in_scope", issue.id);
      const actionable = readNoul("actionable", issue.id);
      const novel = readNoul("novel", issue.id);
      const severityAnswer = answers[key("severity", issue.id)];
      if (grounded === null || inScope === null || actionable === null || novel === null) continue;
      const score = compositeScore({
        grounded,
        // An issue whose line range isn't in the diff is about pre-existing
        // code by construction — the anchor fit already proved it, so don't
        // let a generous in-scope answer paper over it.
        in_scope: offDiff ? Math.min(inScope, 0.2) : inScope,
        actionable,
        novel,
        severity:
          severityAnswer !== undefined && severityAnswer.type === "score"
            ? severityAnswer.score
            : 0,
        declaredSeverity: issue.severity,
      });
      scores.push({ issueId: issue.id, score, lowSignal: isLowSignalScore(score) });
    }

    if (scores.length === 0) return [];

    yield* Effect.sync(() => {
      const now = new Date().toISOString();
      db.transaction(() => {
        for (const s of scores) {
          db.update(walkthroughIssues)
            .set({ advisoryScore: s.score, advisoryScoredAt: now })
            .where(eq(walkthroughIssues.id, s.issueId))
            .run();
        }
      });
    });

    debug(
      "jev",
      `scored ${scores.length} issue(s) for ${walkthroughId}; ${scores.filter((s) => s.lowSignal).length} low signal`,
    );
    return scores;
  });
}
