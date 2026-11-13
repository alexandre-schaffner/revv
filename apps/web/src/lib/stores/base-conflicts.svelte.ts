import type { BaseConflictFrame, BaseConflictsCheck } from "@revv/shared";
import { toast } from "svelte-sonner";
import { api } from "$lib/api/client";
import { ApiError, call } from "$lib/api/errors";
import { sseErrorMessage, streamSse } from "$lib/api/sse-stream";
import { thrownMessage } from "$lib/api/wire";
import { RequestState } from "./_types";
import { createResource } from "./resource";

export interface ProgressRow {
  readonly id: number;
  readonly summary: string;
  readonly toolName: string | null;
}

/**
 * One "Resolve with agent" run, kept until the PR moves or the user dismisses
 * it. A stopped run's outcome is idle again: nothing was pushed.
 */
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
    const check = await call(
      api.api.prs({ id: prId })["base-conflicts"].get({ query: force ? { force: "1" } : {} }),
      "Couldn't check for conflicts",
    );
    return { status: "ok", data: { headSha, check } };
  },
  freshForMs: 30_000,
});

let runs = $state(new Map<string, ResolveRun>());
/** PRs whose run a Stop was asked of, until the server answers. */
let stopping = $state(new Set<string>());
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
    case "stopped":
      updateRun(prId, (run) => ({
        ...run,
        status: "Stopped. Nothing was pushed.",
        outcome: RequestState.idle(),
      }));
      return;
  }
}

/**
 * Start "Resolve with agent" for the PR, pinned to the head the user is
 * looking at. The run carries on on the server if the stream drops; the
 * re-check that follows tells where it ended.
 */
export function resolveBaseConflicts(prId: string, expectedHeadSha: string): void {
  if (runs.get(prId)?.outcome.status === "loading") return;
  setRun(prId, {
    status: "Starting…",
    rows: [],
    agentText: "",
    outcome: RequestState.loading(),
  });
  const controller = new AbortController();
  resolveStreams.set(prId, controller);
  void streamResolve(prId, expectedHeadSha, controller.signal).finally(() => {
    if (controller.signal.aborted) return;
    resolveStreams.delete(prId);
    const asked = checks.argOf(prId);
    if (asked) checkBaseConflicts(prId, asked.headSha, { force: true });
  });
}

async function streamResolve(
  prId: string,
  expectedHeadSha: string,
  signal: AbortSignal,
): Promise<void> {
  let sawResult = false;
  try {
    await streamSse<BaseConflictFrame>({
      path: `/api/prs/${prId}/base-conflicts/resolve`,
      method: "POST",
      body: { expectedHeadSha },
      signal,
      refused: "Couldn't start",
      onEvent: (frame) => {
        if (frame.kind === "result") sawResult = true;
        onFrame(prId, frame);
      },
    });
  } catch (e) {
    const message = sseErrorMessage(e);
    if (signal.aborted || message === null) return;
    if (e instanceof ApiError || !sawResult) failRun(prId, message);
    return;
  }
  if (!sawResult) failRun(prId, "Lost the connection before the run finished");
}

export function isStoppingBaseConflictRun(prId: string): boolean {
  return stopping.has(prId);
}

/**
 * Stop the PR's run while its agent works, also one this window lost the
 * stream of (the run carries on without it). The server answers once the run
 * has ended; its stream, or else a re-check, reports how.
 */
export async function stopBaseConflictRun(prId: string): Promise<void> {
  if (stopping.has(prId)) return;
  stopping = new Set(stopping).add(prId);
  try {
    const { stopped } = await call(
      api.api.prs({ id: prId })["base-conflicts"].resolve.stop.post(),
      "Couldn't stop the agent",
    );
    if (!stopped) {
      toast.message("Nothing to stop: the agent isn't working on these conflicts right now.");
    }
  } catch (e) {
    toast.error(thrownMessage(e));
  } finally {
    const next = new Set(stopping);
    next.delete(prId);
    stopping = next;
  }
  if (!resolveStreams.has(prId)) {
    const asked = checks.argOf(prId);
    if (asked) checkBaseConflicts(prId, asked.headSha, { force: true });
  }
}

function failRun(prId: string, message: string): void {
  if (runs.get(prId)?.outcome.status !== "loading") return;
  updateRun(prId, (run) => ({ ...run, status: null, outcome: RequestState.error(message) }));
}

/** Resolve runs carry on server-side; only this window stops listening. */
export function reset(): void {
  for (const controller of resolveStreams.values()) controller.abort();
  resolveStreams.clear();
  checks.reset();
  runs = new Map();
  stopping = new Set();
}
