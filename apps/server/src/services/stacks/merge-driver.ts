// ── Stack merge: the step loop ──────────────────────────────────────────────
//
// Advances one run until it completes, fails, or is cancelled. Every step
// starts from a fresh read of GitHub, so a step is idempotent: a run picks up
// wherever GitHub says it is, whoever moved it there. Everything outward
// (GitHub, the DB, the clock) comes through `MergeDriverPort`, which keeps the
// loop testable against a scripted GitHub.

import type {
  MergeMethod,
  StackMergeRun,
  StackMergeRunLayer,
  StackRebaseResult,
} from "@revv/shared";
import { Effect } from "effect";
import {
  type DbError,
  GitHubApiError,
  type GitHubError,
  GitHubNetworkError,
  GitHubRateLimitError,
} from "../../domain/errors";
import type { GitHubStack } from "./map";
import {
  layerStateFor,
  nextStep,
  reconcileLayers,
  type StackRead,
  type StepDecision,
  withinBudget,
} from "./merge-plan";

/** Between reads while GitHub retargets or recomputes a layer. */
export const STEP_POLL_MS = 3_000;
/** Between reads while checks run or auto-merge holds a layer: minutes, not seconds. */
export const SLOW_POLL_MS = 10_000;
/** Consecutive failed reads of GitHub before the run stops. */
export const MAX_READ_FAILURES = 5;

export interface SaveEffects {
  /** PR numbers this step merged (or saw merged), for the local PR rows. */
  readonly merged: readonly number[];
  /** The stack's shape moved: a merge or a retarget. */
  readonly stackMoved: boolean;
}

export interface MergeDriverPort {
  /** The stack as GitHub has it now; null when GitHub no longer reports it. */
  readonly read: (run: StackMergeRun) => Effect.Effect<StackRead | null, GitHubError>;
  readonly merge: (
    number: number,
    method: MergeMethod,
    sha: string,
  ) => Effect.Effect<void, GitHubError>;
  readonly retarget: (number: number, base: string) => Effect.Effect<void, GitHubError>;
  readonly enableAutoMerge: (
    nodeId: string,
    method: MergeMethod,
    sha: string,
  ) => Effect.Effect<void, GitHubError>;
  /**
   * Rebase every open layer of `stack` onto the one below it and push them.
   * Answers the layers it moved, or why it couldn't, in the reader's terms.
   */
  readonly rebase: (stack: GitHubStack) => Effect.Effect<StackRebaseResult["rebased"], string>;
  /**
   * Commit the run, then announce it. False when the row has left
   * `running`/`waiting` (the user cancelled): the loop stops without
   * touching GitHub again.
   */
  readonly save: (run: StackMergeRun, effects: SaveEffects) => Effect.Effect<boolean, DbError>;
  /** Still `running`/`waiting` in the DB; checked when a step changes nothing. */
  readonly isActive: (runId: string) => Effect.Effect<boolean, DbError>;
  readonly now: () => number;
  readonly sleep: (ms: number) => Effect.Effect<void>;
}

const isTransient = (e: GitHubError) =>
  e instanceof GitHubNetworkError || e instanceof GitHubRateLimitError;

function describe(e: GitHubError): string {
  if (e instanceof GitHubApiError) return `GitHub answered ${e.status}`;
  if (e instanceof GitHubRateLimitError) return "GitHub's rate limit";
  if (e instanceof GitHubNetworkError) return "GitHub couldn't be reached";
  return e._tag === "GitHubAuthError" ? "Revv's GitHub sign-in expired" : "GitHub refused";
}

function withLayer(
  layers: readonly StackMergeRunLayer[],
  number: number,
  patch: Partial<Pick<StackMergeRunLayer, "state" | "message">>,
): StackMergeRunLayer[] {
  return layers.map((l) => (l.number === number ? { ...l, ...patch } : l));
}

const sameRun = (a: StackMergeRun, b: StackMergeRun) =>
  a.status === b.status &&
  a.error === b.error &&
  JSON.stringify(a.layers) === JSON.stringify(b.layers);

/** What a GitHub write failing means for the run. */
function writeFailure(decision: StepDecision, e: GitHubError): string {
  const n = "number" in decision ? decision.number : 0;
  if (decision.kind === "merge" && e instanceof GitHubApiError) {
    // `sha` pins the merge; 409 is GitHub saying the head moved.
    if (e.status === 409) return `#${n} got new commits after you confirmed — review them first`;
    if (e.status === 405) return `GitHub won't merge #${n} right now — Continue to try again`;
  }
  if (decision.kind === "retarget") return `Couldn't point #${n} at its new base: ${describe(e)}`;
  if (decision.kind === "auto_merge") {
    return `Couldn't hand #${n} to GitHub auto-merge: ${describe(e)}`;
  }
  return `Couldn't merge #${n}: ${describe(e)}`;
}

/**
 * Step `initial` to a terminal state. Fails only on a DB error; everything
 * GitHub does wrong ends the run as `failed` with a message the user reads.
 */
export function driveRun(
  initial: StackMergeRun,
  port: MergeDriverPort,
): Effect.Effect<StackMergeRun, DbError> {
  return Effect.gen(function* () {
    let run = initial;
    /** The wait the run is in, and since when: a budget runs per layer and reason. */
    const waiting: { key: string | null; since: number } = { key: null, since: 0 };
    let readFailures = 0;

    /** Commit a new state of the run; false when it's no longer ours to drive. */
    const commit = (next: StackMergeRun, effects: SaveEffects) =>
      Effect.gen(function* () {
        if (sameRun(run, next) && effects.merged.length === 0 && !effects.stackMoved) {
          return yield* port.isActive(run.id);
        }
        const stamped = { ...next, updatedAt: new Date(port.now()).toISOString() };
        const kept = yield* port.save(stamped, effects);
        if (kept) run = stamped;
        return kept;
      });

    const stop = (number: number | null, message: string) =>
      commit(
        {
          ...run,
          status: "failed",
          error: message,
          layers:
            number === null
              ? run.layers
              : withLayer(run.layers, number, { state: "failed", message }),
        },
        { merged: [], stackMoved: false },
      );

    while (true) {
      const read = yield* Effect.either(port.read(run));
      if (read._tag === "Left") {
        readFailures += 1;
        if (!isTransient(read.left) || readFailures >= MAX_READ_FAILURES) {
          yield* stop(null, `${describe(read.left)} — Continue to try again`);
          return run;
        }
        if (!(yield* port.isActive(run.id))) return run;
        yield* port.sleep(STEP_POLL_MS * readFailures);
        continue;
      }
      readFailures = 0;
      if (read.right === null) {
        yield* stop(null, "GitHub no longer reports this stack — finish the rest on GitHub");
        return run;
      }
      const stackRead = read.right;

      const before = run.layers;
      const layers = reconcileLayers(before, stackRead);
      const mergedNow = layers
        .filter((l, i) => l.state === "merged" && before[i]?.state !== "merged")
        .map((l) => l.number);

      let decision = nextStep({ ...run, layers }, stackRead);
      if (decision.kind === "wait") {
        const key = `${decision.number}:${decision.reason}`;
        if (waiting.key !== key) {
          waiting.key = key;
          waiting.since = port.now();
        }
        decision = withinBudget(decision, port.now() - waiting.since, stackRead.stack.baseRefName);
      }
      if (decision.kind !== "wait") waiting.key = null;

      const state = layerStateFor(decision);
      const stepped: StackMergeRun = {
        ...run,
        layers:
          state && "number" in decision
            ? withLayer(layers, decision.number, {
                state,
                message: decision.kind === "fail" ? decision.message : null,
              })
            : layers,
      };
      const moved = { merged: mergedNow, stackMoved: mergedNow.length > 0 };

      switch (decision.kind) {
        case "complete": {
          yield* commit({ ...stepped, status: "complete", error: null }, moved);
          return run;
        }
        case "fail": {
          yield* commit({ ...stepped, status: "failed", error: decision.message }, moved);
          return run;
        }
        case "wait": {
          if (!(yield* commit({ ...stepped, status: "waiting" }, moved))) return run;
          const slow = decision.reason === "checks" || decision.reason === "auto_merge";
          yield* port.sleep(slow ? SLOW_POLL_MS : STEP_POLL_MS);
          continue;
        }
        case "rebase": {
          if (!(yield* commit({ ...stepped, status: "running" }, moved))) return run;
          const done = yield* Effect.either(port.rebase(stackRead.stack));
          if (done._tag === "Left") {
            yield* stop(decision.number, done.left);
            return run;
          }
          const pushed = new Map(done.right.map((l) => [l.number, l]));
          if (!pushed.has(decision.number)) {
            // Git found nothing to replay, yet GitHub won't take it as is.
            yield* stop(
              decision.number,
              `#${decision.number} needs a rebase onto ${stackRead.stack.baseRefName}`,
            );
            return run;
          }
          // The rebased heads are Revv's own, made from the ones the user
          // confirmed: the run merges those instead.
          const rebased = run.layers.map((l): StackMergeRunLayer => {
            const moved = pushed.get(l.number);
            if (!moved) return l;
            return {
              ...l,
              expectedHeadSha: moved.to,
              rebasedFrom: moved.from,
              ...(l.number === decision.number
                ? {
                    state: "merging" as const,
                    message: `Rebased onto ${stackRead.stack.baseRefName}`,
                  }
                : {}),
            };
          });
          if (!(yield* commit({ ...run, layers: rebased }, { merged: [], stackMoved: true }))) {
            return run;
          }
          yield* port.sleep(STEP_POLL_MS);
          continue;
        }
        case "retarget":
        case "merge":
        case "auto_merge": {
          // Committed before the write: a cancel that landed first wins.
          if (!(yield* commit({ ...stepped, status: "running" }, moved))) return run;
          const write =
            decision.kind === "retarget"
              ? port.retarget(decision.number, decision.base)
              : decision.kind === "merge"
                ? port.merge(decision.number, run.method, decision.sha)
                : port.enableAutoMerge(decision.nodeId, run.method, decision.sha);
          const done = yield* Effect.either(write);
          if (done._tag === "Left") {
            yield* stop(decision.number, writeFailure(decision, done.left));
            return run;
          }
          if (decision.kind === "merge") {
            const merged = withLayer(run.layers, decision.number, {
              state: "merged",
              message: null,
            });
            if (
              !(yield* commit(
                { ...run, layers: merged },
                { merged: [decision.number], stackMoved: true },
              ))
            ) {
              return run;
            }
            // GitHub needs a moment to retarget the next layer anyway.
            yield* port.sleep(STEP_POLL_MS);
          } else if (decision.kind === "retarget") {
            yield* commit(run, { merged: [], stackMoved: true });
            yield* port.sleep(STEP_POLL_MS);
          } else {
            yield* port.sleep(SLOW_POLL_MS);
          }
          continue;
        }
      }
    }
  });
}
