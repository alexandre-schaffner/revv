import type { ActivityKind, ProposedCommit } from "@revv/shared";
import { SvelteMap } from "svelte/reactivity";
import { toast } from "svelte-sonner";
import { thrownMessage } from "$lib/api/wire";
import { createResource } from "$lib/stores/resource";
import {
  advanceWorktree,
  batchCherryPickProposedCommits,
  batchDiscardProposedCommits,
  cherryPickProposedCommit,
  discardProposedCommit,
  fetchProposedChanges,
  type MergePushError,
  type MergePushResult,
  type ProposedChanges,
  type PushProposedOptions,
  pushProposedChanges,
  rebaseProposedCommits,
  resolveConflictsAndPush,
} from "./api";
import { appendItem, isChatStreaming, writeTurn } from "./timeline.svelte";

/**
 * Feedback on a line of a proposed commit, bound for the chat agent. Not a PR
 * review thread: the commit isn't on the remote, and the agent may rewrite it.
 */
export interface ProposedComment {
  id: string;
  filePath: string;
  lineNumber: number;
  side: "deletions" | "additions";
  body: string;
}

/** The PR head moved while the worktree still held unpushed agent commits. */
export interface WorktreeBlockedState {
  oldHeadSha: string;
  newHeadSha: string;
  commits: readonly ProposedCommit[];
}

/** A push the PR branch refused because the agent's commits conflict with it. */
export interface PushConflict {
  files: readonly string[];
  branch: string;
}

type BranchOp = "push" | "resolve" | "rebase" | "batch";
type CommitOp = "discard" | "cherry-pick";

interface ProposedEntry {
  readonly selected: ReadonlySet<string>;
  readonly blocked: WorktreeBlockedState | null;
  /** Comments per commit SHA. */
  readonly comments: ReadonlyMap<string, readonly ProposedComment[]>;
  readonly busy: ReadonlySet<BranchOp>;
  readonly commitOps: ReadonlyMap<string, CommitOp>;
  readonly conflict: PushConflict | null;
}

const EMPTY: ProposedEntry = {
  selected: new Set(),
  blocked: null,
  comments: new Map(),
  busy: new Set(),
  commitOps: new Map(),
  conflict: null,
};
const NO_COMMENTS: readonly ProposedComment[] = [];

const entries = new SvelteMap<string, ProposedEntry>();
const resolveControllers = new Map<string, AbortController>();

const changes = createResource<string, ProposedChanges>({
  keepDataOnError: true,
  fetch: async (prId) => ({ status: "ok", data: await fetchProposedChanges(prId) }),
});

function entry(prId: string): ProposedEntry {
  return entries.get(prId) ?? EMPTY;
}

function updateEntry(prId: string, update: (e: ProposedEntry) => ProposedEntry): void {
  entries.set(prId, update(entry(prId)));
}

function withSet<T>(set: ReadonlySet<T>, value: T, on: boolean): ReadonlySet<T> {
  const next = new Set(set);
  if (on) next.add(value);
  else next.delete(value);
  return next;
}

function setBusy(prId: string, op: BranchOp, on: boolean): void {
  updateEntry(prId, (e) => ({ ...e, busy: withSet(e.busy, op, on) }));
}

function setCommitOp(prId: string, sha: string, op: CommitOp | null): void {
  updateEntry(prId, (e) => {
    const commitOps = new Map(e.commitOps);
    if (op) commitOps.set(sha, op);
    else commitOps.delete(sha);
    return { ...e, commitOps };
  });
}

function dropComments(prId: string, shas: readonly string[]): void {
  updateEntry(prId, (e) => {
    const comments = new Map(e.comments);
    for (const sha of shas) comments.delete(sha);
    return { ...e, comments };
  });
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function getProposedChanges(prId: string): ProposedChanges | null {
  return changes.data(prId);
}

export function getWorktreeBlocked(prId: string): WorktreeBlockedState | null {
  return entry(prId).blocked;
}

/** Selected commits that are still proposed (the agent may have rewritten some). */
export function getSelectedCommitShas(prId: string): ReadonlySet<string> {
  const { selected } = entry(prId);
  if (selected.size === 0) return selected;
  const live = new Set(getProposedChanges(prId)?.commits.map((c) => c.sha));
  return new Set([...selected].filter((sha) => live.has(sha)));
}

export function getProposedComments(prId: string, sha: string): readonly ProposedComment[] {
  return entry(prId).comments.get(sha) ?? NO_COMMENTS;
}

export function isPushingProposed(prId: string): boolean {
  return entry(prId).busy.has("push");
}

export function isResolvingPush(prId: string): boolean {
  return entry(prId).busy.has("resolve");
}

export function isRebasingProposed(prId: string): boolean {
  return entry(prId).busy.has("rebase");
}

export function isBatchOpInFlight(prId: string): boolean {
  return entry(prId).busy.has("batch");
}

/** A push, resolve, rebase, batch or single-commit operation holds the PR's worktree. */
export function isWorktreeOpRunning(prId: string): boolean {
  const e = entry(prId);
  return e.busy.size > 0 || e.commitOps.size > 0;
}

/**
 * Whether something holds the PR's worktree: an operation above or an agent
 * turn. The server's workspace claim refuses a second one; this only keeps
 * the UI from offering it.
 */
export function isWorktreeBusy(prId: string): boolean {
  return isWorktreeOpRunning(prId) || isChatStreaming(prId);
}

/** The PR's last push that conflicted with its branch, until resolved or dismissed. */
export function getPushConflict(prId: string): PushConflict | null {
  return entry(prId).conflict;
}

export function dismissPushConflict(prId: string): void {
  if (entry(prId).conflict) updateEntry(prId, (e) => ({ ...e, conflict: null }));
}

export function isDiscardingCommit(prId: string, sha: string): boolean {
  return entry(prId).commitOps.get(sha) === "discard";
}

export function isCherryPickingCommit(prId: string, sha: string): boolean {
  return entry(prId).commitOps.get(sha) === "cherry-pick";
}

export async function refreshProposedChanges(prId: string): Promise<void> {
  await changes.refresh(prId, prId);
}

export function setWorktreeBlocked(prId: string, blocked: WorktreeBlockedState | null): void {
  updateEntry(prId, (e) => ({ ...e, blocked }));
}

export function toggleCommitSelection(prId: string, sha: string): void {
  updateEntry(prId, (e) => ({ ...e, selected: withSet(e.selected, sha, !e.selected.has(sha)) }));
}

export function selectAllCommits(prId: string, shas: readonly string[]): void {
  updateEntry(prId, (e) => ({ ...e, selected: new Set(shas) }));
}

export function clearCommitSelection(prId: string): void {
  if (entry(prId).selected.size === 0) return;
  updateEntry(prId, (e) => ({ ...e, selected: new Set() }));
}

function setComments(prId: string, sha: string, list: readonly ProposedComment[]): void {
  updateEntry(prId, (e) => {
    const comments = new Map(e.comments);
    if (list.length === 0) comments.delete(sha);
    else comments.set(sha, list);
    return { ...e, comments };
  });
}

export function addProposedComment(prId: string, sha: string, comment: ProposedComment): void {
  setComments(prId, sha, [...getProposedComments(prId, sha), comment]);
}

export function updateProposedComment(prId: string, sha: string, id: string, body: string): void {
  setComments(
    prId,
    sha,
    getProposedComments(prId, sha).map((c) => (c.id === id ? { ...c, body } : c)),
  );
}

export function removeProposedComment(prId: string, sha: string, id: string): void {
  setComments(
    prId,
    sha,
    getProposedComments(prId, sha).filter((c) => c.id !== id),
  );
}

export function clearProposedComments(prId: string, sha: string): void {
  setComments(prId, sha, []);
}

/** Forget the PR's proposed commits; an operation in flight keeps its spinner. */
export function clearProposed(prId: string): void {
  changes.invalidate(prId);
  updateEntry(prId, (e) => ({ ...EMPTY, busy: e.busy, commitOps: e.commitOps }));
}

/**
 * Merge the agent's commits into the PR branch and push, or with
 * `newBranchName` push them to a new branch instead. Toasts success and hard
 * failures and records a `conflict` for the PR; returns the result (null on a
 * hard failure) so the caller can handle `ref-exists`.
 */
export async function pushProposed(
  prId: string,
  options?: PushProposedOptions,
): Promise<MergePushResult | null> {
  if (isPushingProposed(prId)) return null;
  setBusy(prId, "push", true);
  try {
    const result = await pushProposedChanges(prId, options);
    if (result.status === "pushed") {
      toast.success(`Pushed ${plural(result.pushedCommits, "commit")} to ${result.branch}`);
      void refreshProposedChanges(prId);
    } else if (result.status === "remote-changed") {
      toast.error(
        `The PR branch (${result.branch}) was updated remotely. Sync the latest changes and try again.`,
      );
    } else if (result.status === "conflict") {
      const conflict = { files: result.files, branch: result.branch };
      updateEntry(prId, (e) => ({ ...e, conflict }));
    }
    return result;
  } catch (e) {
    toast.error((e as MergePushError).message ?? "Push failed");
    return null;
  } finally {
    setBusy(prId, "push", false);
  }
}

/**
 * Let the agent resolve a conflicting push, then push. Its progress is shown
 * in the timeline as a turn of its own; the server doesn't persist that turn,
 * so it is gone after a reload (the branch is the durable record).
 */
export function resolveAndPushProposed(prId: string): Promise<void> {
  if (isResolvingPush(prId)) return Promise.resolve();
  dismissPushConflict(prId);
  setBusy(prId, "resolve", true);

  const turnId = crypto.randomUUID();
  appendItem(prId, {
    kind: "message",
    id: crypto.randomUUID(),
    role: "user",
    content: "(Resolve push conflicts)",
    isStreaming: false,
    turnId,
  });
  const turn = writeTurn(prId, turnId);
  const statusRow = (summary: string) =>
    turn.row({
      kind: "activity",
      id: crypto.randomUUID(),
      activityKind: "tool.other",
      toolName: "merge-and-push",
      summary,
      turnId,
    });

  return new Promise<void>((resolve) => {
    const finish = (error?: string) => {
      turn.seal(error);
      resolveControllers.delete(prId);
      setBusy(prId, "resolve", false);
      resolve();
    };
    const controller = resolveConflictsAndPush(prId, {
      onStatus: statusRow,
      onConflictFiles: (files) =>
        statusRow(
          `Conflicts in ${plural(files.length, "file")}: ${files.slice(0, 3).join(", ")}${
            files.length > 3 ? "…" : ""
          }`,
        ),
      onAgentText: (chunk) => turn.text(chunk),
      onAgentActivity: (activity) =>
        turn.row({
          kind: "activity",
          id: crypto.randomUUID(),
          activityKind: activity.activityKind as ActivityKind,
          toolName: activity.toolName ?? activity.activityKind,
          summary: activity.summary,
          turnId,
        }),
      onResult: (result) => {
        turn.seal();
        if (result.status === "pushed") {
          toast.success(`Pushed ${plural(result.pushedCommits, "commit")} to ${result.branch}`);
          void refreshProposedChanges(prId);
        } else if (result.status === "remote-changed") {
          toast.error(`The PR branch (${result.branch}) moved during push. Sync and retry.`);
        } else {
          toast.error(result.message);
        }
      },
      onError: (err) => {
        toast.error(err.message || "Conflict resolution failed");
        finish(err.message);
      },
      onDone: () => finish(),
    });
    resolveControllers.set(prId, controller);
  });
}

/**
 * Discard one agent commit. While the worktree is blocked, discarding the last
 * blocked commit advances the worktree to the new PR head.
 */
export async function discardProposedCommitAction(prId: string, sha: string): Promise<void> {
  if (entry(prId).commitOps.has(sha)) return;
  setCommitOp(prId, sha, "discard");
  try {
    await discardProposedCommit(prId, sha);
    const blocked = getWorktreeBlocked(prId);
    if (blocked) {
      const remaining = blocked.commits.filter((c) => c.sha !== sha);
      if (remaining.length === 0) {
        await advanceWorktree(prId, blocked.newHeadSha);
        setWorktreeBlocked(prId, null);
        await refreshProposedChanges(prId);
      } else {
        setWorktreeBlocked(prId, { ...blocked, commits: remaining });
      }
    } else {
      await refreshProposedChanges(prId);
      dropComments(prId, [sha]);
    }
    toast.success("Commit discarded");
  } catch (err) {
    toast.error(thrownMessage(err));
  } finally {
    setCommitOp(prId, sha, null);
  }
}

export async function cherryPickProposedCommitAction(prId: string, sha: string): Promise<void> {
  if (entry(prId).commitOps.has(sha)) return;
  setCommitOp(prId, sha, "cherry-pick");
  try {
    await cherryPickProposedCommit(prId, sha);
    await refreshProposedChanges(prId);
    toast.success("Commit pushed to PR branch");
  } catch (err) {
    toast.error(thrownMessage(err));
  } finally {
    setCommitOp(prId, sha, null);
  }
}

export async function rebaseAllProposedAction(prId: string): Promise<void> {
  const blocked = getWorktreeBlocked(prId);
  if (!blocked || isRebasingProposed(prId)) return;
  setBusy(prId, "rebase", true);
  try {
    await rebaseProposedCommits(prId, blocked.oldHeadSha, blocked.newHeadSha);
    await advanceWorktree(prId, blocked.newHeadSha);
    setWorktreeBlocked(prId, null);
    await refreshProposedChanges(prId);
    toast.success("Commits rebased onto new PR head");
  } catch (err) {
    toast.error(thrownMessage(err));
  } finally {
    setBusy(prId, "rebase", false);
  }
}

async function runOnSelection(
  prId: string,
  run: (shas: string[]) => Promise<string>,
  failure: string,
): Promise<void> {
  if (isBatchOpInFlight(prId)) return;
  const shas = [...getSelectedCommitShas(prId)];
  if (shas.length === 0) return;
  setBusy(prId, "batch", true);
  try {
    const success = await run(shas);
    dropComments(prId, shas);
    clearCommitSelection(prId);
    await refreshProposedChanges(prId);
    toast.success(success);
  } catch (err) {
    toast.error(err instanceof Error ? err.message : failure);
  } finally {
    setBusy(prId, "batch", false);
  }
}

export function batchCherryPickSelectedAction(prId: string): Promise<void> {
  return runOnSelection(
    prId,
    async (shas) => {
      const result = await batchCherryPickProposedCommits(prId, shas);
      return `Pushed ${plural(result.pushedCommits, "commit")}${
        result.branch ? ` to ${result.branch}` : ""
      }`;
    },
    "Failed to push commits",
  );
}

/** Discard the selected commits in one rebuild of the agent branch. */
export function batchDiscardSelectedAction(prId: string): Promise<void> {
  return runOnSelection(
    prId,
    async (shas) => {
      const result = await batchDiscardProposedCommits(prId, shas);
      return `Discarded ${plural(result.discardedCount, "commit")}`;
    },
    "Failed to discard commits",
  );
}

export function reset(): void {
  for (const controller of resolveControllers.values()) controller.abort();
  resolveControllers.clear();
  entries.clear();
  changes.reset();
}
