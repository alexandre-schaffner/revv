// ── Stack merge: the pure half ──────────────────────────────────────────────
//
// What can merge, how far, and what a run does next, decided from one read of
// GitHub. No I/O here: `StackMerge.ts` reads GitHub, feeds the read in, and
// carries out whatever this returns.
//
// GitHub's native-stack merge behaviour hasn't been observed yet (the S0 spike
// needs a stack, and stacks can't be made through the API), so every place
// that leans on an assumption about it is a named constant below, with what
// S0 has to confirm.

import type {
  MergeMethod,
  StackMergeMode,
  StackMergePlanLayer,
  StackMergeReadiness,
  StackMergeRun,
  StackMergeRunLayer,
} from "@revv/shared";
import type { GitHubStack, GitHubStackLayer } from "./map";

/** Merge states GitHub would let through right now. */
const MERGEABLE_STATES = new Set(["CLEAN", "HAS_HOOKS", "UNSTABLE"]);

/**
 * A layer whose base is a lower layer's branch is judged on its own reviews
 * and checks: GitHub may report it BLOCKED (or UNKNOWN) only because it can't
 * merge before the layers under it land. Unverified until S0.
 */
const UPPER_LAYER_BLOCKED_MEANS_WAITING = true;

/**
 * After the layer below merges, wait this long for GitHub to point the next
 * layer at the stack base itself before Revv does it.
 */
export const RETARGET_WAIT_MS = 60_000;
/**
 * Revv retargets a layer GitHub didn't (`PATCH /pulls/:n {base}`). S0 must
 * confirm that a PATCHed base keeps the PR in its stack; if it doesn't, turn
 * this off and the run stops with a message instead.
 */
export const RETARGET_BY_PATCH = true;
/** GitHub recomputes mergeability lazily; a fresh base leaves it UNKNOWN for a while. */
export const MERGEABILITY_WAIT_MS = 2 * 60_000;
/**
 * Required checks register a few seconds after a base change, and until they
 * do GitHub reports BLOCKED with nothing to show for it. Grace before reading
 * BLOCKED as branch protection.
 */
export const PROTECTION_GRACE_MS = 60_000;
/** A driven run waits this long for a layer's checks, then stops. */
export const CHECKS_WAIT_MS = 30 * 60_000;
/** How long a run watches a layer it handed to GitHub's auto-merge. */
export const AUTO_MERGE_WAIT_MS = 45 * 60_000;

// ── Readiness ───────────────────────────────────────────────────────────────

export interface LayerReadiness {
  readonly readiness: StackMergeReadiness;
  /** Why a blocked layer can't merge, or what a ready one is still waiting on. */
  readonly reasons: readonly string[];
}

function onStackBase(layer: GitHubStackLayer, stack: GitHubStack): boolean {
  return layer.baseRef === stack.baseRefName;
}

/** Reviews and checks, the layer's own requirements whatever its base. */
function ownBlockers(layer: GitHubStackLayer): { hard: string[]; checksRunning: boolean } {
  const hard: string[] = [];
  if (layer.reviewDecision === "changes_requested") hard.push("Changes requested");
  if (layer.reviewDecision === "review_required") hard.push("Review required");
  if (layer.checks === "failure" || layer.checks === "error") hard.push("Checks failing");
  const checksRunning = layer.checks === "pending" || layer.checks === "expected";
  return { hard, checksRunning };
}

/**
 * Whether GitHub would merge this layer once everything below it landed.
 * In `auto` mode a layer only waiting on checks is ready: GitHub's auto-merge
 * takes it from there.
 */
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

  const state = layer.mergeStateStatus ?? "UNKNOWN";
  if (state === "DIRTY") {
    return { readiness: "blocked", reasons: [`Conflicts with ${layer.baseRef}`] };
  }
  if (state === "BEHIND" || (layer.behindBy ?? 0) > 0) {
    const behind = `Behind ${layer.baseRef}`;
    if (!stack.viewerCanPush) return { readiness: "blocked", reasons: [behind] };
    // The run rebases it before merging, so what's left is the layer's own
    // requirements, which GitHub can't vouch for until then.
    const rest = layerReadiness(
      { ...layer, mergeStateStatus: "UNKNOWN", behindBy: 0 },
      stack,
      mode,
    );
    return rest.readiness === "blocked"
      ? rest
      : { readiness: "ready", reasons: [`${behind}: Revv rebases it first`, ...rest.reasons] };
  }
  if (MERGEABLE_STATES.has(state)) return { readiness: "ready", reasons: [] };

  const { hard, checksRunning } = ownBlockers(layer);
  if (hard.length > 0) return { readiness: "blocked", reasons: hard };
  if (checksRunning) {
    return mode === "auto"
      ? { readiness: "ready", reasons: ["Checks still running; GitHub merges it when they pass"] }
      : { readiness: "blocked", reasons: ["Checks still running"] };
  }
  // Nothing of its own holds it. On the stack base, BLOCKED is branch
  // protection; on a lower layer's branch it's the layers below.
  if (state === "BLOCKED") {
    if (!onStackBase(layer, stack) && UPPER_LAYER_BLOCKED_MEANS_WAITING) {
      return { readiness: "ready", reasons: [] };
    }
    return { readiness: "blocked", reasons: ["Blocked by branch protection"] };
  }
  // UNKNOWN (GitHub still computing), DRAFT-ish states we didn't model: a run
  // waits for GitHub to settle and stops cleanly if it settles badly.
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

/**
 * The highest position reachable from the lowest open layer through
 * contiguous ready layers. Null when nothing is open or the lowest open
 * layer can't merge.
 */
export function defaultThrough(layers: readonly StackMergePlanLayer[]): number | null {
  let through: number | null = null;
  for (const layer of [...layers].sort((a, b) => a.position - b.position)) {
    if (layer.readiness === "merged") continue;
    if (layer.readiness !== "ready") break;
    through = layer.position;
  }
  return through;
}

// ── Starting a run ──────────────────────────────────────────────────────────

export interface StartRequest {
  readonly throughPosition: number;
  readonly method: MergeMethod;
  /** Head SHAs the user confirmed, by PR number. */
  readonly expectedHeads: Readonly<Record<string, string>>;
}

export interface StartRefusal {
  readonly message: string;
  /** `conflict`: GitHub moved since the user looked. `invalid`: the ask can't be met. */
  readonly reason: "conflict" | "invalid";
}

/** Why a run can't start as asked, in the reader's terms; null when it can. */
export function startRefusal(
  stack: GitHubStack,
  layers: readonly StackMergePlanLayer[],
  req: StartRequest,
): StartRefusal | null {
  const invalid = (message: string): StartRefusal => ({ message, reason: "invalid" });
  // An empty list is a host too old to say; the merge itself is the judge.
  if (stack.allowedMethods.length > 0 && !stack.allowedMethods.includes(req.method)) {
    return invalid(`This repository doesn't allow ${req.method} merges`);
  }
  const target = layers.find((l) => l.position === req.throughPosition);
  if (!target) return invalid(`The stack has no layer ${req.throughPosition}`);
  const upTo = layers.filter((l) => l.position <= req.throughPosition);
  if (upTo.every((l) => l.readiness === "merged")) {
    return invalid(`Everything through #${target.number} is already merged`);
  }
  // A moved head first: the user's whole view of the stack is stale.
  for (const layer of upTo) {
    if (layer.readiness === "merged") continue;
    const expected = req.expectedHeads[String(layer.number)];
    if (!expected || expected !== layer.headSha) {
      return {
        message: `#${layer.number} got new commits since you opened this — review them first`,
        reason: "conflict",
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

/** The run's layers as confirmed: every layer through the target, base first. */
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

// ── Stepping a run ──────────────────────────────────────────────────────────

/** One read of GitHub, as a step sees it. */
export interface StackRead {
  readonly stack: GitHubStack;
  /** Run layers GitHub's stack no longer lists but reports merged on their own. */
  readonly mergedOutside: ReadonlySet<number>;
}

export type WaitReason = "retarget" | "mergeability" | "protection" | "checks" | "auto_merge";

export type StepDecision =
  | { readonly kind: "complete" }
  | { readonly kind: "fail"; readonly number: number; readonly message: string }
  | { readonly kind: "wait"; readonly number: number; readonly reason: WaitReason }
  | { readonly kind: "retarget"; readonly number: number; readonly base: string }
  | { readonly kind: "merge"; readonly number: number; readonly sha: string }
  /** The layer fell behind its base (a merge below moved it): rebase the stack, once. */
  | { readonly kind: "rebase"; readonly number: number }
  | {
      readonly kind: "auto_merge";
      readonly number: number;
      readonly nodeId: string;
      readonly sha: string;
    };

const isMerged = (read: StackRead, number: number) =>
  read.mergedOutside.has(number) ||
  read.stack.layers.some((l) => l.number === number && l.status === "merged");

/** The run's layers with whatever GitHub reports merged marked so. */
export function reconcileLayers(
  layers: readonly StackMergeRunLayer[],
  read: StackRead,
): StackMergeRunLayer[] {
  return layers.map((l) =>
    l.state !== "merged" && isMerged(read, l.number) ? { ...l, state: "merged", message: null } : l,
  );
}

/**
 * What to do about the lowest layer not yet merged. Waits come back without a
 * budget; `withinBudget` turns an overlong one into its fallback.
 */
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
  if (!layer) return { kind: "fail", number, message: `#${number} is no longer in this stack` };

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
  // Already handed over; GitHub merges it when it's ready.
  if (target.state === "auto_merge" && layer.autoMergeEnabled) {
    return { kind: "wait", number, reason: "auto_merge" };
  }
  // Everything below has merged, so this layer belongs on the stack base.
  if (!onStackBase(layer, read.stack)) return { kind: "wait", number, reason: "retarget" };

  const state = layer.mergeStateStatus ?? "UNKNOWN";
  if (state === "UNKNOWN") return { kind: "wait", number, reason: "mergeability" };
  // A stacked PR only merges with a linear history. GitHub rebases what's
  // left of a stack after its own merges, not after Revv's, so the run does.
  if (state === "DIRTY" || state === "BEHIND" || (layer.behindBy ?? 0) > 0) {
    return target.rebasedFrom === undefined && read.stack.viewerCanPush
      ? { kind: "rebase", number }
      : {
          kind: "fail",
          number,
          message: `#${number} needs a rebase onto ${read.stack.baseRefName}`,
        };
  }
  if (MERGEABLE_STATES.has(state)) {
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

/** A wait past its budget becomes what the run does instead of waiting longer. */
export function withinBudget(
  decision: StepDecision,
  waitedMs: number,
  baseRefName: string,
): StepDecision {
  if (decision.kind !== "wait" || waitedMs < BUDGETS[decision.reason]) return decision;
  const { number } = decision;
  switch (decision.reason) {
    case "retarget":
      return RETARGET_BY_PATCH
        ? { kind: "retarget", number, base: baseRefName }
        : {
            kind: "fail",
            number,
            message: `GitHub didn't point #${number} at ${baseRefName} after the layer below merged`,
          };
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

/** The layer state a decision puts its layer in while the run carries it out. */
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
