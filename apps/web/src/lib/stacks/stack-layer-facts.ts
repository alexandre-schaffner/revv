import {
  isOpenLayer,
  type ReviewVerdict,
  type RiskLevel,
  type StackBrief,
  type StackEntryStatus,
  type StackLayer,
} from "@revv/shared";
import { VERDICT_TONE } from "$lib/conversation/verdict";
import { plural } from "$lib/utils/plural";

export const LAYER_STATUS_LABEL: Record<StackEntryStatus, string> = {
  merged: "Merged",
  closed: "Closed",
  draft: "Draft",
  ready: "Ready",
  not_ready: "Not ready",
};

export const RISK_LABEL: Record<RiskLevel, string> = {
  low: "Low risk",
  medium: "Medium risk",
  high: "High risk",
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

export { layerNeedsReview as needsReview } from "@revv/shared";

export function readableBrief(brief: StackBrief | null): StackBrief | null {
  if (!brief) return null;
  return brief.status === "complete" || brief.status === "superseded" ? brief : null;
}

export function layerRole(layer: StackLayer, brief: StackBrief | null): string | null {
  const fromBrief = brief?.layers.find((l) => l.prNumber === layer.number)?.role.trim();
  if (fromBrief) return fromBrief;
  if (layer.review.kind === "complete") return layer.review.takeaway?.trim() || null;
  return null;
}

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
      tone: VERDICT_TONE[verdict],
      verdict,
    });
  }
  return facts;
}
