import {
  classifyLayerMergeState,
  type MergeMethod,
  type StackMergeMode,
  type StackMergePlanLayer,
  type StackMergeReadiness,
  type StackMergeRun,
  type StackMergeRunLayer,
} from "@revv/shared";
import type { GitHubStack, GitHubStackLayer } from "./map";
import {
  baseWasMoved,
  blockedOnlyByLayersBelow,
  contradiction,
  type UnverifiedStackBehaviour,
} from "./unverified-github";

/**
 * After the layer below merges, wait this long for GitHub to point the next
 * layer at the stack base itself before Revv does it.
 */
export const RETARGET_WAIT_MS = 60_000;
/** GitHub recomputes mergeability lazily; a fresh base leaves it UNKNOWN for a while. */
export const MERGEABILITY_WAIT_MS = 2 * 60_000;
/**
 * Required checks register a few seconds after a base change, and until they
 * do GitHub reports BLOCKED with nothing to show for it. Grace before reading
 * BLOCKED as branch protection.
 */
export const PROTECTION_GRACE_MS = 60_000;
export const CHECKS_WAIT_MS = 30 * 60_000;
export const AUTO_MERGE_WAIT_MS = 45 * 60_000;

export interface LayerReadiness {
  readonly readiness: StackMergeReadiness;
  readonly reasons: readonly string[];
}

function onStackBase(layer: GitHubStackLayer, stack: GitHubStack): boolean {
  return layer.baseRef === stack.baseRefName;
}

function ownBlockers(layer: GitHubStackLayer): { hard: string[]; checksRunning: boolean } {
  const hard: string[] = [];
  if (layer.reviewDecision === "changes_requested") hard.push("Changes requested");
  if (layer.reviewDecision === "review_required") hard.push("Review required");
  if (layer.checks === "failure" || layer.checks === "error") hard.push("Checks failing");
  const checksRunning = layer.checks === "pending" || layer.checks === "expected";
  return { hard, checksRunning };
}

export function layerReadiness(
  layer: GitHubStackLayer,
  stack: GitHubStack,
  mode: StackMergeMode,
): LayerReadiness {
  if (layer.status === "merged") return { readiness: "merged", reasons: [] };
  if (layer.status === "closed") {
    return { readiness: "blocked", reasons: ["Closed without merging"] };
  }
  if (layer.status === "draft") return { readiness: "blocked", reasons: ["Still a draft"] };

  const mergeState = classifyLayerMergeState(layer);
  if (mergeState === "conflicts") {
    return { readiness: "blocked", reasons: [`Conflicts with ${layer.baseRef}`] };
  }
  if (mergeState === "behind") {
    const behind = `Behind ${layer.baseRef}`;
    if (!stack.viewerCanPush) return { readiness: "blocked", reasons: [behind] };
    const rest = layerReadiness(
      { ...layer, mergeStateStatus: "UNKNOWN", behindBy: 0 },
      stack,
      mode,
    );
    return rest.readiness === "blocked"
      ? rest
      : { readiness: "ready", reasons: [`${behind}: Revv rebases it first`, ...rest.reasons] };
  }
  if (mergeState === "mergeable") return { readiness: "ready", reasons: [] };

  const { hard, checksRunning } = ownBlockers(layer);
  if (hard.length > 0) return { readiness: "blocked", reasons: hard };
  if (checksRunning) {
    return mode === "auto"
      ? { readiness: "ready", reasons: ["Checks still running; GitHub merges it when they pass"] }
      : { readiness: "blocked", reasons: ["Checks still running"] };
  }
  if (blockedOnlyByLayersBelow(layer, stack)) return { readiness: "ready", reasons: [] };
  if (mergeState === "blocked") {
    return { readiness: "blocked", reasons: ["Blocked by branch protection"] };
  }
  return { readiness: "ready", reasons: [] };
}

export function mergeModeOf(stack: GitHubStack): StackMergeMode {
  return stack.autoMergeAllowed ? "auto" : "driven";
}

export function planLayers(
  stack: GitHubStack,
  prIds: ReadonlyMap<number, string>,
): StackMergePlanLayer[] {
  const mode = mergeModeOf(stack);
  return stack.layers.map((layer) => {
    const { readiness, reasons } = layerReadiness(layer, stack, mode);
    return {
      position: layer.position,
      number: layer.number,
      title: layer.title,
      prId: prIds.get(layer.number) ?? null,
      headSha: layer.headSha,
      status: layer.status,
      readiness,
      reasons,
    };
  });
}

export function defaultThrough(layers: readonly StackMergePlanLayer[]): number | null {
  let through: number | null = null;
  for (const layer of [...layers].sort((a, b) => a.position - b.position)) {
    if (layer.readiness === "merged") continue;
    if (layer.readiness !== "ready") break;
    through = layer.position;
  }
  return through;
}

export interface StartRequest {
  readonly throughPosition: number;
  readonly method: MergeMethod;
  readonly expectedHeads: Readonly<Record<string, string>>;
}

export interface StartRefusal {
  readonly message: string;
  readonly reason: "stale" | "invalid";
}

export function startRefusal(
  stack: GitHubStack,
  layers: readonly StackMergePlanLayer[],
  req: StartRequest,
): StartRefusal | null {
  const invalid = (message: string): StartRefusal => ({ message, reason: "invalid" });
  if (!stack.allowedMethods.includes(req.method)) {
    return invalid(`This repository doesn't allow ${req.method} merges`);
  }
  const target = layers.find((l) => l.position === req.throughPosition);
  if (!target) return invalid(`The stack has no layer ${req.throughPosition}`);
  const upTo = layers.filter((l) => l.position <= req.throughPosition);
  if (upTo.every((l) => l.readiness === "merged")) {
    return invalid(`Everything through #${target.number} is already merged`);
  }
  for (const layer of upTo) {
    if (layer.readiness === "merged") continue;
    const expected = req.expectedHeads[String(layer.number)];
    if (!expected || expected !== layer.headSha) {
      return {
        message: `#${layer.number} got new commits since you opened this — review them first`,
        reason: "stale",
      };
    }
  }
  for (const layer of upTo) {
    if (layer.readiness === "blocked") {
      return invalid(`#${layer.number} can't merge yet: ${layer.reasons[0] ?? "blocked"}`);
    }
  }
  return null;
}

export function initialRunLayers(
  layers: readonly StackMergePlanLayer[],
  throughPosition: number,
): StackMergeRunLayer[] {
  return layers
    .filter((l) => l.position <= throughPosition)
    .sort((a, b) => a.position - b.position)
    .map((l) => ({
      position: l.position,
      number: l.number,
      expectedHeadSha: l.headSha ?? "",
      state: l.readiness === "merged" ? "merged" : "pending",
      message: null,
    }));
}

export interface StackRead {
  readonly stack: GitHubStack;
  readonly mergedUnlisted: ReadonlySet<number>;
}

/** Run layers to ask GitHub for the stack through: still-open first, top down. */
export function stackAskOrder(layers: readonly StackMergeRunLayer[]): StackMergeRunLayer[] {
  return [...layers].sort(
    (a, b) =>
      Number(a.state === "merged") - Number(b.state === "merged") || b.position - a.position,
  );
}

export type WaitReason = "retarget" | "mergeability" | "protection" | "checks" | "auto_merge";

export type StepDecision =
  | { readonly kind: "complete" }
  | {
      readonly kind: "fail";
      readonly number: number;
      readonly message: string;
      readonly contradicts?: UnverifiedStackBehaviour;
    }
  | { readonly kind: "wait"; readonly number: number; readonly reason: WaitReason }
  | { readonly kind: "retarget"; readonly number: number; readonly base: string }
  | { readonly kind: "merge"; readonly number: number; readonly sha: string }
  | { readonly kind: "rebase"; readonly number: number }
  | {
      readonly kind: "auto_merge";
      readonly number: number;
      readonly nodeId: string;
      readonly sha: string;
    };

const isMerged = (read: StackRead, number: number) =>
  read.mergedUnlisted.has(number) ||
  read.stack.layers.some((l) => l.number === number && l.status === "merged");

export function reconcileLayers(
  layers: readonly StackMergeRunLayer[],
  read: StackRead,
): StackMergeRunLayer[] {
  return layers.map((l) =>
    l.state !== "merged" && isMerged(read, l.number) ? { ...l, state: "merged", message: null } : l,
  );
}

function aboveBeforeRebase(
  layers: readonly StackMergeRunLayer[],
  read: StackRead,
  number: number,
): StepDecision | null {
  for (const l of layers) {
    if (l.number === number || l.state === "merged" || isMerged(read, l.number)) continue;
    const head = read.stack.layers.find((s) => s.number === l.number)?.headSha;
    if (head === undefined || head === l.expectedHeadSha) continue;
    // Revv's last rebase pushed it; GitHub may still report the old head.
    if (l.rebasedFrom !== undefined && head === l.rebasedFrom) {
      return { kind: "wait", number, reason: "mergeability" };
    }
    return {
      kind: "fail",
      number: l.number,
      message: `#${l.number} got new commits after you confirmed — review them first`,
    };
  }
  return null;
}

export function nextStep(
  run: Pick<StackMergeRun, "layers" | "mode">,
  read: StackRead,
): StepDecision {
  const target = [...run.layers]
    .sort((a, b) => a.position - b.position)
    .find((l) => l.state !== "merged" && !isMerged(read, l.number));
  if (!target) return { kind: "complete" };
  const { number } = target;
  const layer = read.stack.layers.find((l) => l.number === number);
  if (!layer) {
    const message = `#${number} is no longer in this stack`;
    return baseWasMoved(target)
      ? contradiction("base-change-keeps-membership", number, message)
      : { kind: "fail", number, message };
  }

  if (layer.status === "closed") return { kind: "fail", number, message: `#${number} was closed` };
  // The run's own rebase pushed this layer; GitHub may still report the old head.
  if (target.rebasedFrom !== undefined && layer.headSha === target.rebasedFrom) {
    return { kind: "wait", number, reason: "mergeability" };
  }
  if (layer.headSha !== target.expectedHeadSha) {
    return {
      kind: "fail",
      number,
      message: `#${number} got new commits after you confirmed — review them first`,
    };
  }
  if (target.state === "auto_merge" && layer.autoMergeEnabled) {
    return { kind: "wait", number, reason: "auto_merge" };
  }
  if (!onStackBase(layer, read.stack)) return { kind: "wait", number, reason: "retarget" };

  const mergeState = classifyLayerMergeState(layer);
  // A stacked PR only merges with a linear history. GitHub rebases what's
  // left of a stack after its own merges, not after Revv's, so the run does.
  if (mergeState === "behind" || mergeState === "conflicts") {
    if (target.rebasedToMerge || !read.stack.viewerCanPush) {
      return {
        kind: "fail",
        number,
        message: `#${number} needs a rebase onto ${read.stack.baseRefName}`,
      };
    }
    return aboveBeforeRebase(run.layers, read, number) ?? { kind: "rebase", number };
  }
  if (mergeState === "unknown") return { kind: "wait", number, reason: "mergeability" };
  if (mergeState === "mergeable") {
    return { kind: "merge", number, sha: target.expectedHeadSha };
  }
  if (layer.status === "draft") return { kind: "fail", number, message: `#${number} is a draft` };

  const { hard, checksRunning } = ownBlockers(layer);
  const first = hard[0];
  if (first !== undefined) {
    return { kind: "fail", number, message: `#${number}: ${first.toLowerCase()}` };
  }
  if (checksRunning) {
    // Handed over already: GitHub's read of it can lag the mutation, and
    // enabling it twice is a refusal, not a no-op.
    if (run.mode !== "auto") return { kind: "wait", number, reason: "checks" };
    return target.state === "auto_merge"
      ? { kind: "wait", number, reason: "auto_merge" }
      : { kind: "auto_merge", number, nodeId: layer.nodeId, sha: target.expectedHeadSha };
  }
  return { kind: "wait", number, reason: "protection" };
}

const BUDGETS: Record<WaitReason, number> = {
  retarget: RETARGET_WAIT_MS,
  mergeability: MERGEABILITY_WAIT_MS,
  protection: PROTECTION_GRACE_MS,
  checks: CHECKS_WAIT_MS,
  auto_merge: AUTO_MERGE_WAIT_MS,
};

export function withinBudget(
  decision: StepDecision,
  waitedMs: number,
  baseRefName: string,
): StepDecision {
  if (decision.kind !== "wait" || waitedMs < BUDGETS[decision.reason]) return decision;
  const { number } = decision;
  switch (decision.reason) {
    case "retarget":
      return { kind: "retarget", number, base: baseRefName };
    case "mergeability":
      return {
        kind: "fail",
        number,
        message: `GitHub couldn't work out whether #${number} can merge — Continue to try again`,
      };
    case "protection":
      return { kind: "fail", number, message: `#${number} is blocked by branch protection` };
    case "checks":
      return { kind: "fail", number, message: `#${number}'s checks didn't finish in time` };
    case "auto_merge":
      return {
        kind: "fail",
        number,
        message: `GitHub hasn't merged #${number} yet. Auto-merge stays on; Continue to check again`,
      };
  }
}

export function layerStateFor(decision: StepDecision): StackMergeRunLayer["state"] | null {
  switch (decision.kind) {
    case "wait":
      if (decision.reason === "retarget") return "retargeting";
      return decision.reason === "auto_merge" ? "auto_merge" : "merging";
    case "retarget":
      return "retargeting";
    case "merge":
      return "merging";
    case "rebase":
      return "rebasing";
    case "auto_merge":
      return "auto_merge";
    case "fail":
      return "failed";
    case "complete":
      return null;
  }
}
