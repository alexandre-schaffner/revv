import type { BaseConflictFrame, BaseConflictsCheck } from "@revv/shared";
import { toast } from "svelte-sonner";
import { fetchBaseConflicts, streamBaseConflictResolve } from "$lib/api/base-conflicts";
import { RequestState } from "./_types";
import { createResource } from "./resource";

export interface ProgressRow {
  readonly id: number;
  readonly summary: string;
  readonly toolName: string | null;
}

/** One "Resolve with agent" run, kept until the PR moves or the user dismisses it. */
export interface ResolveRun {
  readonly status: string | null;
  readonly rows: readonly ProgressRow[];
  readonly agentText: string;
  readonly outcome: RequestState<{ readonly newSha: string; readonly branch: string }>;
}

interface CheckAnswer {
  readonly headSha: string | null;
  readonly check: BaseConflictsCheck;
}

const checks = createResource<
  { readonly headSha: string | null; readonly force: boolean },
  CheckAnswer
>({
  fetch: async (prId, { headSha, force }) => {
    const answer = await fetchBaseConflicts(prId, force);
    return answer.ok
      ? { status: "ok", data: { headSha, check: answer.check } }
      : { status: "error", error: answer.message };
  },
  freshForMs: 30_000,
});

let runs = $state(new Map<string, ResolveRun>());
const resolveStreams = new Map<string, AbortController>();

function setRun(prId: string, run: ResolveRun | null): void {
  if (run) runs.set(prId, run);
  else runs.delete(prId);
  runs = new Map(runs);
}

function updateRun(prId: string, update: (run: ResolveRun) => ResolveRun): void {
  const run = runs.get(prId);
  if (run) setRun(prId, update(run));
}

export interface BaseConflictsView {
  /** The check for the head on screen; null while none answers for it. */
  readonly check: BaseConflictsCheck | null;
  /** Asking for this head with nothing to show yet. */
  readonly checking: boolean;
  readonly error: string | null;
  readonly run: ResolveRun | null;
}

export function getBaseConflicts(prId: string, headSha: string | null): BaseConflictsView {
  const entry = checks.entry(prId);
  const run = runs.get(prId) ?? null;
  if (entry.version !== versionOf(headSha))
    return { check: null, checking: false, error: null, run };
  const { request } = entry;
  const check =
    request.status === "ok" && request.data.headSha === headSha ? request.data.check : null;
  return {
    check,
    checking: check === null && entry.loading,
    error: request.status === "error" ? request.error : null,
    run,
  };
}

const versionOf = (headSha: string | null) => headSha ?? "";

/** Ask the server which files conflict with the base. The last answer stays up meanwhile. */
export function checkBaseConflicts(
  prId: string,
  headSha: string | null,
  opts: { readonly force?: boolean } = {},
): void {
  const version = versionOf(headSha);
  // A finished run belongs to the head it ran against.
  const run = runs.get(prId);
  if (checks.entry(prId).version !== version && run && run.outcome.status !== "loading") {
    setRun(prId, null);
  }
  const arg = { headSha, force: opts.force ?? false };
  void (opts.force && checks.entry(prId).version === version
    ? checks.refresh(prId, arg)
    : checks.load(prId, arg, version));
}

export function dismissBaseConflictRun(prId: string): void {
  setRun(prId, null);
}

let rowIds = 0;

function onFrame(prId: string, frame: BaseConflictFrame): void {
  switch (frame.kind) {
    case "status":
      updateRun(prId, (run) => ({ ...run, status: frame.message }));
      return;
    case "conflict-files":
      return;
    case "agent-text":
      updateRun(prId, (run) => ({ ...run, agentText: run.agentText + frame.data }));
      return;
    case "agent-activity":
      rowIds += 1;
      updateRun(prId, (run) => ({
        ...run,
        rows: [...run.rows, { id: rowIds, summary: frame.summary, toolName: frame.toolName }],
      }));
      return;
    case "result":
      onResult(prId, frame);
      return;
  }
}

function onResult(prId: string, frame: Extract<BaseConflictFrame, { kind: "result" }>): void {
  switch (frame.status) {
    case "pushed":
      toast.success(
        frame.strategy === "merge"
          ? `Resolved the conflicts and pushed to ${frame.branch}`
          : `Rebased and force-pushed ${frame.branch}`,
      );
      updateRun(prId, (run) => ({
        ...run,
        status: null,
        outcome: RequestState.ok({ newSha: frame.newSha, branch: frame.branch }),
      }));
      return;
    case "remote-changed":
      updateRun(prId, (run) => ({
        ...run,
        status: null,
        outcome: RequestState.error(
          `${frame.branch} got new commits while the agent worked — nothing was pushed. Try again.`,
        ),
      }));
      return;
    case "failed":
      updateRun(prId, (run) => ({
        ...run,
        status: null,
        outcome: RequestState.error(frame.message),
      }));
      return;
  }
}

/** Start "Resolve with agent" for the PR, pinned to the head the user is looking at. */
export function resolveBaseConflicts(prId: string, expectedHeadSha: string): void {
  if (runs.get(prId)?.outcome.status === "loading") return;
  setRun(prId, { status: "Starting…", rows: [], agentText: "", outcome: RequestState.loading() });
  const controller = new AbortController();
  resolveStreams.set(prId, controller);
  void streamBaseConflictResolve(prId, expectedHeadSha, {
    signal: controller.signal,
    onFrame: (frame) => onFrame(prId, frame),
    onError: (message) => {
      if (runs.get(prId)?.outcome.status !== "loading") return;
      updateRun(prId, (run) => ({ ...run, status: null, outcome: RequestState.error(message) }));
    },
  }).finally(() => {
    if (controller.signal.aborted) return;
    resolveStreams.delete(prId);
    const version = checks.entry(prId).version;
    checkBaseConflicts(prId, version === "" ? null : version, { force: true });
  });
}

/** Resolve runs carry on server-side; only this window stops listening. */
export function reset(): void {
  for (const controller of resolveStreams.values()) controller.abort();
  resolveStreams.clear();
  checks.reset();
  runs = new Map();
}
