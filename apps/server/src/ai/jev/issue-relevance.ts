// The relevance/severity judgment of one concern `flag_issue` already
// committed: the questions, the policy and the cache key. What it reads from
// the journal, and what its verdict does there, is the caller's
// (`services/walkthrough/issue-gate.ts`).

import { isDiscardedScore, isLowSignalScore } from "@revv/shared";
import { noul, type ScoreQuestion } from "@typesafe-ai/sdk";
import { Effect } from "effect";
import { debug } from "../../logger";
import type { CacheService } from "../../services/Cache";
import { JevService } from "../../services/Jev";
import type { IssueCandidate, IssueJudgment } from "./contracts";
import {
  compositeScore,
  ISSUE_RELEVANCE_CACHE_NS,
  ISSUE_RELEVANCE_CACHE_TTL_MS,
  ISSUE_RELEVANCE_TIMEOUT_MS,
  MUST_FIX_LEVEL,
  type RawIssueJudgment,
  SEVERITY_LEVELS,
  severityForLevel,
} from "./issue-relevance-policy";
import { cachedJev } from "./optional";
import { buildIssueRelevanceState, type IssueRelevanceInput } from "./state";

/** What the judgment reads besides the candidate. */
export interface IssueGateInput {
  readonly pr: IssueRelevanceInput["pr"];
  /** The diff hunk the concern is anchored to, if it could be resolved. */
  readonly hunk: string | null;
  /** The concern's lines fall outside the diff. */
  readonly offDiff: boolean;
  /** The walkthrough's other concerns, for the duplicate check. */
  readonly existingIssues: IssueRelevanceInput["existingIssues"];
}

function answerNoul(value: unknown): number {
  if (value === null || typeof value !== "object" || !("noul" in value)) return 1;
  return typeof value.noul === "number" ? value.noul : 1;
}

function ask(candidate: IssueCandidate, input: IssueGateInput) {
  return Effect.gen(function* () {
    const jev = yield* JevService;
    const { answers } = yield* jev.ask({
      label: "issues",
      timeoutMs: ISSUE_RELEVANCE_TIMEOUT_MS,
      state: buildIssueRelevanceState({
        pr: input.pr,
        issue: {
          severity: candidate.severity,
          title: candidate.title,
          description: candidate.description,
          filePath: candidate.filePath,
          startLine: candidate.startLine,
          endLine: candidate.endLine,
          hunk: input.hunk,
        },
        existingIssues: input.existingIssues,
      }),
      questions: {
        grounded: noul("The claim in `issue` is supported by the code in `issue.hunk`."),
        in_scope: noul(
          "`issue` is about a change this pull request makes, rather than pre-existing code the diff happens to touch.",
        ),
        actionable: noul("`issue` names a specific change a developer could make."),
        novel: noul(
          "`issue` tells the reader something they would not already get from reading the diff.",
        ),
        duplicate: noul(
          "`issue` restates a concern already covered by one of `existing_issues`, rather than raising a new one. False when `existing_issues` is empty.",
        ),
        severity: {
          type: "score",
          instructions: "How consequential is the problem described in `issue`?",
          criteria: SEVERITY_LEVELS,
        } satisfies ScoreQuestion<typeof SEVERITY_LEVELS>,
      },
    });

    const duplicate = answerNoul(answers.duplicate);
    const severityLevel = answers.severity?.score ?? MUST_FIX_LEVEL;
    const score = compositeScore({
      grounded: answerNoul(answers.grounded),
      in_scope: input.offDiff
        ? Math.min(answerNoul(answers.in_scope), 0.2)
        : answerNoul(answers.in_scope),
      actionable: answerNoul(answers.actionable),
      novel: Math.min(answerNoul(answers.novel), 1 - duplicate),
      severity: severityLevel,
      declaredSeverity: candidate.severity,
    });
    return { score, severityLevel } satisfies RawIssueJudgment;
  });
}

function candidateKey(walkthroughId: string, issueId: string, candidate: IssueCandidate): string {
  return [
    walkthroughId,
    issueId,
    candidate.severity,
    candidate.description,
    candidate.endLine ?? "",
  ].join("\0");
}

/** Judge one candidate; null (the concern stands as written) when Jev has no answer. */
export function judgeIssue(
  walkthroughId: string,
  issueId: string,
  candidate: IssueCandidate,
  input: IssueGateInput,
): Effect.Effect<IssueJudgment | null, never, JevService | CacheService> {
  return Effect.gen(function* () {
    const raw = yield* cachedJev<RawIssueJudgment>(
      `issue relevance for ${issueId}`,
      {
        ns: ISSUE_RELEVANCE_CACHE_NS,
        key: candidateKey(walkthroughId, issueId, candidate),
        options: { ttlMs: ISSUE_RELEVANCE_CACHE_TTL_MS },
      },
      () => ask(candidate, input),
    );
    if (raw === null) return null;

    const judgment: IssueJudgment = {
      score: raw.score,
      lowSignal: isLowSignalScore(raw.score),
      discard: isDiscardedScore(raw.score),
      severity: severityForLevel(raw.severityLevel),
    };
    debug(
      "jev",
      `issue ${issueId.slice(0, 8)} scored ${raw.score.toFixed(2)}`,
      judgment.severity === null ? "" : `severity=${judgment.severity}`,
      judgment.discard ? "— retracted" : judgment.lowSignal ? "— low signal" : "",
    );
    return judgment;
  });
}
