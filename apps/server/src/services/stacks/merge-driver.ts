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
import type { Contradiction } from "./unverified-github";

export const STEP_POLL_MS = 3_000;
export const SLOW_POLL_MS = 10_000;
export const MAX_READ_FAILURES = 5;

/** `ended`: the row left `running`/`waiting` (the user cancelled); the loop stops. */
export type RunLiveness = "live" | "ended";

export interface SaveEffects {
  readonly merged: readonly number[];
  readonly stackMoved: boolean;
}

export interface MergeDriverPort {
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
  readonly rebase: (
    stack: GitHubStack,
    proceed: Effect.Effect<boolean>,
  ) => Effect.Effect<StackRebaseResult["rebased"], string>;
  readonly save: (run: StackMergeRun, effects: SaveEffects) => Effect.Effect<RunLiveness, DbError>;
  readonly isActive: (runId: string) => Effect.Effect<boolean, DbError>;
  readonly reportContradiction: (contradiction: Contradiction) => Effect.Effect<void>;
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

export function driveRun(
  initial: StackMergeRun,
  port: MergeDriverPort,
): Effect.Effect<StackMergeRun, DbError> {
  return Effect.gen(function* () {
    let run = initial;
    const waiting: { key: string | null; since: number } = { key: null, since: 0 };
    let readFailures = 0;

    const commit = (next: StackMergeRun, effects: SaveEffects) =>
      Effect.gen(function* () {
        if (sameRun(run, next) && effects.merged.length === 0 && !effects.stackMoved) {
          return (yield* port.isActive(run.id)) ? "live" : "ended";
        }
        const stamped = { ...next, updatedAt: new Date(port.now()).toISOString() };
        const liveness = yield* port.save(stamped, effects);
        if (liveness === "live") run = stamped;
        return liveness;
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
      const read = yield* Effect.result(port.read(run));
      if (read._tag === "Failure") {
        readFailures += 1;
        if (!isTransient(read.failure) || readFailures >= MAX_READ_FAILURES) {
          yield* stop(null, `${describe(read.failure)} — Continue to try again`);
          return run;
        }
        if (!(yield* port.isActive(run.id))) return run;
        yield* port.sleep(STEP_POLL_MS * readFailures);
        continue;
      }
      readFailures = 0;
      if (read.success === null) {
        yield* stop(null, "GitHub no longer reports this stack — finish the rest on GitHub");
        return run;
      }
      const stackRead = read.success;

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
          if (decision.contradicts) {
            yield* port.reportContradiction({
              behaviour: decision.contradicts,
              number: decision.number,
              runId: run.id,
            });
          }
          yield* commit({ ...stepped, status: "failed", error: decision.message }, moved);
          return run;
        }
        case "wait": {
          if ((yield* commit({ ...stepped, status: "waiting" }, moved)) === "ended") return run;
          const slow = decision.reason === "checks" || decision.reason === "auto_merge";
          yield* port.sleep(slow ? SLOW_POLL_MS : STEP_POLL_MS);
          continue;
        }
        case "rebase": {
          if ((yield* commit({ ...stepped, status: "running" }, moved)) === "ended") return run;
          const stillOurs = port.isActive(run.id).pipe(Effect.orElseSucceed(() => false));
          const done = yield* Effect.result(port.rebase(stackRead.stack, stillOurs));
          if (done._tag === "Failure") {
            yield* stop(decision.number, done.failure);
            return run;
          }
          const pushed = new Map(done.success.map((l) => [l.number, l]));
          if (!pushed.has(decision.number)) {
            yield* stop(
              decision.number,
              `#${decision.number} needs a rebase onto ${stackRead.stack.baseRefName}`,
            );
            return run;
          }
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
                    rebasedToMerge: true,
                  }
                : {}),
            };
          });
          if (
            (yield* commit({ ...run, layers: rebased }, { merged: [], stackMoved: true })) ===
            "ended"
          ) {
            return run;
          }
          yield* port.sleep(STEP_POLL_MS);
          continue;
        }
        case "retarget":
        case "merge":
        case "auto_merge": {
          if ((yield* commit({ ...stepped, status: "running" }, moved)) === "ended") return run;
          const write =
            decision.kind === "retarget"
              ? port.retarget(decision.number, decision.base)
              : decision.kind === "merge"
                ? port.merge(decision.number, run.method, decision.sha)
                : port.enableAutoMerge(decision.nodeId, run.method, decision.sha);
          const done = yield* Effect.result(write);
          if (done._tag === "Failure") {
            yield* stop(decision.number, writeFailure(decision, done.failure));
            return run;
          }
          if (decision.kind === "merge") {
            const merged = withLayer(run.layers, decision.number, {
              state: "merged",
              message: null,
            });
            if (
              (yield* commit(
                { ...run, layers: merged },
                { merged: [decision.number], stackMoved: true },
              )) === "ended"
            ) {
              return run;
            }
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
