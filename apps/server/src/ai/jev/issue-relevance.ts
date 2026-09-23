// ── Issue relevance orchestration ────────────────────────────────────────────
//
// `flag_issue` commits immediately. This module schedules the optional
// relevance/severity judgment behind the agent; policy, DB reads, and writes
// live in separate modules so each can be tested without the others.

import { isDiscardedScore, isLowSignalScore } from "@revv/shared";
import { noul, type ScoreQuestion } from "@typesafe-ai/sdk";
import { Effect } from "effect";
import type { Db } from "../../db";
import type { JevUnavailable } from "../../domain/errors";
import { debug } from "../../logger";
import { CacheService } from "../../services/Cache";
import type { DbService } from "../../services/Db";
import { JevService } from "../../services/Jev";
import { SettingsService } from "../../services/Settings";
import type { IssueCandidate, IssueJudgment } from "./contracts";
import { collectIssueGateInput, type IssueGateInput } from "./issue-relevance-context";
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
import { optionalJev } from "./optional";
import { buildIssueRelevanceState } from "./state";

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

/** Judge one candidate, degrading to the exact pre-Jev behavior on failure. */
export function judgeIssue(
  db: Db,
  walkthroughId: string,
  issueId: string,
  candidate: IssueCandidate,
): Effect.Effect<
  IssueJudgment | null,
  never,
  JevService | SettingsService | CacheService | DbService
> {
  return Effect.gen(function* () {
    const settingsService = yield* SettingsService;
    const settings = yield* settingsService.getSettings().pipe(Effect.orElseSucceed(() => null));
    const wantsGate = settings?.jev.issueScoring === true;
    const wantsSeverity = settings?.jev.issueSeverity === true;
    if (!wantsGate && !wantsSeverity) return null;

    const input = yield* Effect.sync(() => collectIssueGateInput(db, walkthroughId, candidate));
    if (input === null) return null;

    const cache = yield* CacheService;
    const raw = yield* optionalJev(
      `issue relevance for ${issueId}`,
      cache.getOrFetch<RawIssueJudgment, JevUnavailable, JevService>(
        ISSUE_RELEVANCE_CACHE_NS,
        candidateKey(walkthroughId, issueId, candidate),
        () => ask(candidate, input),
        { ttlMs: ISSUE_RELEVANCE_CACHE_TTL_MS },
      ),
    );
    if (raw === null) return null;

    const judgment: IssueJudgment = {
      score: raw.score,
      lowSignal: isLowSignalScore(raw.score),
      discard: wantsGate && isDiscardedScore(raw.score),
      severity: wantsSeverity ? severityForLevel(raw.severityLevel) : null,
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
