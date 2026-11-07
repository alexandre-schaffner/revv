// What the generating agent reads back from the journal at the start of every
// run, resumes included (invariant 6): where the pipeline stands, what it has
// written so far, what it still owes, and the review an incremental run builds on.

import type {
  RatingAxis,
  RiskLevel,
  WalkthroughBlock,
  WalkthroughGenerationMode,
  WalkthroughMode,
  WalkthroughPipelinePhase,
  WalkthroughState,
} from "@revv/shared";
import type { Db } from "../../db";
import { readWalkthroughLeads } from "../walkthrough-leads";
import {
  decodeIssue,
  decodeRating,
  decodeSemanticStep,
  findIssuesMissingInlineComment,
  isRatedAxis,
  loadContentRows,
  loadWalkthroughRow,
  type WalkthroughRow,
} from "./content";

function priorReviewOf(
  db: Db,
  prior: WalkthroughRow,
): NonNullable<WalkthroughState["priorReview"]> {
  const content = loadContentRows(db, prior.id);
  return {
    walkthroughId: prior.id,
    prHeadSha: prior.prHeadSha,
    summary: prior.summary,
    riskLevel: prior.riskLevel as RiskLevel,
    sentiment: prior.sentiment ?? null,
    semanticSteps: content.semanticSteps.map(decodeSemanticStep),
    issues: content.issues.map((row) => {
      const issue = decodeIssue(row);
      return {
        id: issue.id,
        severity: issue.severity,
        title: issue.title,
        description: issue.description,
        filePath: row.filePath,
        startLine: row.startLine,
        endLine: row.endLine,
        submittedAt: row.submittedAt,
      };
    }),
    ratings: content.ratings.map((row) => {
      const { axis, verdict, confidence, rationale } = decodeRating(row);
      return { axis, verdict, confidence, rationale };
    }),
  };
}

/** The walkthrough's state as `get_walkthrough_state` reports it, or null when the row is gone. */
export function readWalkthroughState(db: Db, walkthroughId: string): WalkthroughState | null {
  const row = loadWalkthroughRow(db, walkthroughId);
  if (!row) return null;
  const content = loadContentRows(db, walkthroughId);
  const diffBlocks = content.blocks.filter((b) => b.phase === "diff_analysis");

  const stepIndicesBySection = new Map<number, number[]>();
  for (const b of diffBlocks) {
    const indices = stepIndicesBySection.get(b.semanticStepIndex) ?? [];
    indices.push(b.stepIndex);
    stepIndicesBySection.set(b.semanticStepIndex, indices);
  }

  const issues = content.issues.map((r) => ({
    id: r.id,
    title: r.title,
    filePath: r.filePath,
    startLine: r.startLine,
    endLine: r.endLine,
  }));
  const leads = readWalkthroughLeads(db, walkthroughId).map((lead) => ({
    id: lead.id,
    filePath: lead.filePath,
    newStart: lead.newStart,
    newLines: lead.newLines,
    smells: lead.smells.map((s) => s.smell),
    verdict: lead.verdict,
    issueId: lead.issueId,
  }));
  const prior = row.parentWalkthroughId ? loadWalkthroughRow(db, row.parentWalkthroughId) : null;

  return {
    walkthroughId: row.id,
    prHeadSha: row.prHeadSha,
    mode: row.mode as WalkthroughMode,
    generationMode: row.generationMode as WalkthroughGenerationMode,
    parentWalkthroughId: row.parentWalkthroughId ?? null,
    baseHeadSha: row.baseHeadSha ?? null,
    priorReview: prior ? priorReviewOf(db, prior) : null,
    status: row.status,
    lastCompletedPhase: row.lastCompletedPhase as WalkthroughPipelinePhase,
    summary: row.summary || null,
    riskLevel: row.summary ? (row.riskLevel as RiskLevel) : null,
    sentiment: row.sentiment ?? null,
    semanticSteps: content.semanticSteps.map((s) => ({
      ...decodeSemanticStep(s),
      stepIndices: (stepIndicesBySection.get(s.semanticStepIndex) ?? []).sort((a, b) => a - b),
    })),
    diffSteps: diffBlocks.map((b) => ({
      semanticStepIndex: b.semanticStepIndex,
      stepIndex: b.stepIndex,
      blockType: b.type as WalkthroughBlock["type"],
    })),
    ratedAxes: content.ratings.filter(isRatedAxis).map((r) => r.axis as RatingAxis),
    issues,
    issueCount: issues.length,
    issuesNeedingInlineComment: findIssuesMissingInlineComment(db, walkthroughId),
    leads,
    leadsNeedingVerdict: leads.filter((lead) => lead.verdict === null).map((lead) => lead.id),
  };
}
