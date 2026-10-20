// ── What the walkthrough's stack surfaces say about one layer ──────────────
//
// The overview's rows and the handoff card describe a layer with the same
// words: its role in the stack, its risk, its open issues, the viewer's own
// verdict, and anything the restack check found. One place decides them, so
// a layer never reads two ways on one page.

import {
  isOpenLayer,
  type ReviewVerdict,
  type RiskLevel,
  type StackBrief,
  type StackLayer,
} from "@revv/shared";
import { plural } from "$lib/utils/plural";

export const RISK_LABEL: Record<RiskLevel, string> = {
  low: "Low risk",
  medium: "Medium risk",
  high: "High risk",
};

/** The viewer's own latest review, in their voice. */
export const REVIEW_VERDICT_LABEL: Record<ReviewVerdict, string> = {
  approved: "You approved",
  changes_requested: "You requested changes",
  commented: "You commented",
  dismissed: "Your review was dismissed",
};

type Tone = "subtle" | "success" | "warning" | "danger" | "accent";

export type LayerFact =
  | { readonly kind: "risk"; readonly key: string; readonly tone: Tone; readonly risk: RiskLevel }
  | {
      readonly kind: "verdict";
      readonly key: string;
      readonly tone: Tone;
      readonly verdict: ReviewVerdict;
    }
  | { readonly kind: "text"; readonly key: string; readonly tone: Tone; readonly label: string };

/**
 * The layer has no review of its current head (and none on the way). A
 * review carried over a restack counts: the layer's own changes are the
 * ones it read.
 */
export function needsReview(layer: StackLayer): boolean {
  const { review } = layer;
  if (review.kind === "generating") return false;
  if (review.kind !== "complete") return true;
  if (layer.restack.kind === "restacked") return false;
  return (
    review.reviewedHeadSha !== null &&
    layer.headSha !== null &&
    review.reviewedHeadSha !== layer.headSha
  );
}

/** The stack's brief, when it has one worth reading: written, even if for an older version. */
export function readableBrief(brief: StackBrief | null): StackBrief | null {
  if (!brief) return null;
  return brief.status === "complete" || brief.status === "superseded" ? brief : null;
}

/** What the layer contributes: the brief's one line for it, else its walkthrough's takeaway. */
export function layerRole(layer: StackLayer, brief: StackBrief | null): string | null {
  const fromBrief = brief?.layers.find((l) => l.prNumber === layer.number)?.role.trim();
  if (fromBrief) return fromBrief;
  if (layer.review.kind === "complete") return layer.review.takeaway?.trim() || null;
  return null;
}

/** What landed is the stack's history: its review's findings no longer ask anything. */
export function layerFacts(layer: StackLayer): LayerFact[] {
  const facts: LayerFact[] = [];
  if (!isOpenLayer(layer)) return facts;
  if (layer.restack.kind === "needs-rebase") {
    facts.push({ kind: "text", key: "restack", tone: "warning", label: "Needs a rebase" });
  } else if (layer.restack.kind === "layer-changed") {
    facts.push({ kind: "text", key: "restack", tone: "accent", label: "Changed since review" });
  }
  const { review } = layer;
  if (review.kind === "complete") {
    if (review.riskLevel) {
      facts.push({ kind: "risk", key: "risk", tone: "subtle", risk: review.riskLevel });
    }
    if (review.criticalIssues > 0) {
      facts.push({
        kind: "text",
        key: "critical",
        tone: "danger",
        label: `${review.criticalIssues} critical`,
      });
    }
    const rest = review.openIssues - review.criticalIssues;
    if (rest > 0) {
      const label = plural(rest, review.criticalIssues > 0 ? "more issue" : "issue");
      facts.push({ kind: "text", key: "issues", tone: "subtle", label });
    }
  }
  const verdict = layer.viewerReview;
  if (verdict && verdict !== "dismissed") {
    facts.push({
      kind: "verdict",
      key: "verdict",
      tone:
        verdict === "approved" ? "success" : verdict === "changes_requested" ? "warning" : "subtle",
      verdict,
    });
  }
  return facts;
}
