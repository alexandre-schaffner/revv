import type { BaseConflictFrame, BaseConflictsCheck } from "@revv/shared";
import { toast } from "svelte-sonner";
import { fetchBaseConflicts, streamBaseConflictResolve } from "$lib/api/base-conflicts";
import { RequestState } from "./_types";

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

interface Entry {
  /** The PR head `check` was asked for; a check for another head is stale. */
  readonly headSha: string | null;
  readonly check: RequestState<BaseConflictsCheck>;
  readonly askedAt: number;
  readonly run: ResolveRun | null;
}

const FRESH_FOR_MS = 30_000;

const EMPTY: Entry = { headSha: null, check: RequestState.idle(), askedAt: 0, run: null };

let entries = $state(new Map<string, Entry>());

const generations = new Map<string, number>();

function setEntry(prId: string, entry: Entry): void {
  entries.set(prId, entry);
  entries = new Map(entries);
}

function updateEntry(prId: string, update: (entry: Entry) => Entry): void {
  setEntry(prId, update(entries.get(prId) ?? EMPTY));
}

export function getBaseConflicts(prId: string): Entry {
  return entries.get(prId) ?? EMPTY;
}

/** The check for `headSha`, or null while none answers for that head. */
export function getBaseConflictsCheck(
  prId: string,
  headSha: string | null,
): BaseConflictsCheck | null {
  const entry = entries.get(prId);
  if (!entry || entry.headSha !== headSha || entry.check.status !== "ok") return null;
  return entry.check.data;
}

/**
 * Ask the server which files conflict with the base, unless an answer for
 * this head is in flight or under `FRESH_FOR_MS` old. The last answer stays
 * up meanwhile.
 */
export function checkBaseConflicts(
  prId: string,
  headSha: string | null,
  opts: { readonly force?: boolean } = {},
): void {
  const entry = getBaseConflicts(prId);
  const sameHead = entry.headSha === headSha;
  if (
    !opts.force &&
    sameHead &&
    (entry.check.status === "loading" || Date.now() - entry.askedAt < FRESH_FOR_MS)
  ) {
    return;
  }
  const generation = (generations.get(prId) ?? 0) + 1;
  generations.set(prId, generation);
  setEntry(prId, {
    headSha,
    check: sameHead && entry.check.status === "ok" ? entry.check : RequestState.loading(),
    askedAt: Date.now(),
    // A finished run belongs to the head it ran against.
    run: sameHead || entry.run?.outcome.status === "loading" ? entry.run : null,
  });
  void fetchBaseConflicts(prId, opts.force ?? false).then((answer) => {
    if (generations.get(prId) !== generation) return;
    updateEntry(prId, (current) => ({
      ...current,
      check: answer.ok ? RequestState.ok(answer.check) : RequestState.error(answer.message),
    }));
  });
}

export function dismissBaseConflictRun(prId: string): void {
  updateEntry(prId, (entry) => ({ ...entry, run: null }));
}

function updateRun(prId: string, update: (run: ResolveRun) => ResolveRun): void {
  updateEntry(prId, (entry) => (entry.run ? { ...entry, run: update(entry.run) } : entry));
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
  if (getBaseConflicts(prId).run?.outcome.status === "loading") return;
  updateEntry(prId, (entry) => ({
    ...entry,
    run: { status: "Starting…", rows: [], agentText: "", outcome: RequestState.loading() },
  }));
  void streamBaseConflictResolve(prId, expectedHeadSha, {
    onFrame: (frame) => onFrame(prId, frame),
    onError: (message) => {
      if (getBaseConflicts(prId).run?.outcome.status !== "loading") return;
      updateRun(prId, (run) => ({ ...run, status: null, outcome: RequestState.error(message) }));
    },
  }).finally(() => checkBaseConflicts(prId, getBaseConflicts(prId).headSha, { force: true }));
}
