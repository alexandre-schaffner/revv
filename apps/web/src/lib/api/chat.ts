// ── Chat API ────────────────────────────────────────────────────────────────
//
// Right-pane AI chat HTTP/SSE client. Surfaces typed frames
// (`{kind: 'text' | 'activity', ...}`) so the chat panel can render rich
// activity entries inline between messages.
//
// History reload (gap A1) — `fetchChatMessages(prId)` pulls the persisted
// timeline (messages + activities, ordered by sequence) so the panel hydrates
// from SQLite on mount instead of starting empty after a desktop reload.

import type {
  Activity,
  ApiErrorCode,
  ChatAttachment,
  ChatSessionContext,
  ChatStreamFrame,
  ChatTask,
  InteractionMode,
  StreamErrorBody,
} from "@revv/shared";
import { api } from "$lib/api/client";
import { apiErrorCode, apiErrorMessage } from "$lib/api/errors";
import { SseFrameError, SseHttpError, SseIdleError, streamSse } from "$lib/api/sse-stream";
import type { EdenData } from "$lib/api/wire";

// Re-export activity types used by stores and components.
export type { Activity, ChatTask, InteractionMode };

export interface ChatRequestParams {
  prId: string;
  message: string;
  interactionMode?: InteractionMode;
  approvedPlanId?: string;
  attachments?: ReadonlyArray<ChatAttachment>;
}

export interface ChatCallbacks {
  onText: (chunk: string) => void;
  onActivity: (activity: Activity) => void;
  onActivityResult: (params: { callId: string; output: string; isError: boolean }) => void;
  onActivityInput: (params: { callId: string; payload: unknown }) => void;
  onTaskList: (params: { turnId: string; tasks: ReadonlyArray<ChatTask> }) => void;
  onPlanPresented: (params: { planId: string; turnId: string; markdown: string }) => void;
  onDone: () => void;
  onError: (error: StreamErrorBody) => void;
}

/**
 * Open a streaming chat turn. Returns an AbortController so the caller can
 * cancel mid-stream (e.g. when the user sends a new message before the
 * previous one finishes).
 */
export function streamChatMessage(
  params: ChatRequestParams,
  callbacks: ChatCallbacks,
): AbortController {
  const controller = new AbortController();
  void settleAgentStream(
    streamSse<ChatStreamFrame>({
      path: "/api/chat",
      method: "POST",
      body: {
        prId: params.prId,
        message: params.message,
        ...(params.attachments !== undefined ? { attachments: params.attachments } : {}),
        ...(params.interactionMode !== undefined
          ? { interactionMode: params.interactionMode }
          : {}),
        ...(params.approvedPlanId !== undefined ? { approvedPlanId: params.approvedPlanId } : {}),
      },
      signal: controller.signal,
      onEvent: (frame) => dispatchChatFrame(frame, callbacks),
    }),
    callbacks,
  );
  return controller;
}

function dispatchChatFrame(frame: ChatStreamFrame, callbacks: ChatCallbacks): void {
  if (frame.kind === "text") {
    callbacks.onText(frame.data);
  } else if (frame.kind === "reasoning") {
    // Reasoning frames are intentionally dropped — the
    // chat panel never surfaces model reasoning.
  } else if (frame.kind === "activity") {
    callbacks.onActivity({
      activityKind: frame.activityKind,
      toolName: frame.toolName,
      summary: frame.summary,
      payload: frame.payload,
      ...(frame.callId !== undefined ? { callId: frame.callId } : {}),
    });
  } else if (frame.kind === "activity-result") {
    callbacks.onActivityResult({
      callId: frame.callId,
      output: frame.output,
      isError: frame.isError,
    });
  } else if (frame.kind === "activity-input") {
    callbacks.onActivityInput({ callId: frame.callId, payload: frame.payload });
  } else if (frame.kind === "task-list") {
    callbacks.onTaskList({
      turnId: frame.turnId,
      tasks: frame.tasks,
    });
  } else if (frame.kind === "plan-presented") {
    callbacks.onPlanPresented({
      planId: frame.planId,
      turnId: frame.turnId,
      markdown: frame.markdown,
    });
  }
}

const LOST_CONNECTION_MESSAGE =
  "Lost connection to the local server. The agent may have stopped — check the server logs and try again.";

/**
 * Report an agent stream's end through the chat-style callbacks: `onDone`
 * when it closed cleanly, `onError` otherwise, nothing when the caller
 * aborted it (the caller already finalized its UI).
 */
async function settleAgentStream(
  stream: Promise<void>,
  callbacks: {
    onDone: () => void;
    onError: (error: StreamErrorBody) => void;
  },
): Promise<void> {
  try {
    await stream;
  } catch (err) {
    const error = agentStreamError(err);
    if (error) callbacks.onError(error);
    return;
  }
  callbacks.onDone();
}

function agentStreamError(err: unknown): StreamErrorBody | null {
  if (err instanceof SseHttpError) {
    return typeof err.body === "object" && err.body !== null
      ? (err.body as StreamErrorBody)
      : { code: "UNKNOWN", message: err.statusText };
  }
  if (err instanceof SseFrameError) return { code: err.code, message: err.message };
  if (err instanceof SseIdleError)
    return { code: "NETWORK_ERROR", message: LOST_CONNECTION_MESSAGE };
  if (!(err instanceof Error)) return { code: "NETWORK_ERROR", message: String(err) };
  if (err.name === "AbortError") return null;
  // WebKit surfaces connection drops as "Load failed"; Chromium as "Failed to fetch".
  const isConnectionDrop = err.message === "Load failed" || err.message === "Failed to fetch";
  return {
    code: "NETWORK_ERROR",
    message: isConnectionDrop ? LOST_CONNECTION_MESSAGE : err.message,
  };
}

function chat(prId: string) {
  return api.api.chat({ prId });
}

/** Clear the agent-side session and worktree+branch for this PR's chat. */
export async function clearChat(prId: string): Promise<void> {
  const { error } = await chat(prId).delete();
  if (error) throw new Error(apiErrorMessage(error, "Failed to clear chat"));
}

// ── Plan / interaction-mode endpoints ─────────────────────────────────────

export async function setInteractionMode(prId: string, mode: InteractionMode): Promise<void> {
  const { error } = await chat(prId)["interaction-mode"].patch({ mode });
  if (error) throw new Error(apiErrorMessage(error, "Failed to set interaction mode"));
}

export async function approvePlan(prId: string, planId: string): Promise<void> {
  const { error } = await chat(prId).plan({ planId }).approve.post();
  if (error) throw new Error(apiErrorMessage(error, "Approve failed"));
}

export async function rejectPlan(prId: string, planId: string): Promise<void> {
  const { error } = await chat(prId).plan({ planId }).reject.post();
  if (error) throw new Error(apiErrorMessage(error, "Reject failed"));
}

export type AvailableAgents = EdenData<typeof api.api.chat.agents.available.get>;

export async function fetchAvailableAgents(): Promise<AvailableAgents> {
  const { data, error } = await api.api.chat.agents.available.get();
  if (error) throw new Error(apiErrorMessage(error, "Failed to load available agents"));
  return data;
}

export async function fetchSessionContext(
  prId: string,
  opts: { warm?: boolean } = {},
): Promise<ChatSessionContext> {
  // `warm=1` opts into the server's eager path (acquire worktree + harvest slash
  // commands) so the `/`-command menu works on a brand-new chat. The plain fetch
  // stays side-effect-free.
  const { data, error } = await chat(prId)["session-context"].get({
    query: opts.warm ? { warm: "1" } : {},
  });
  if (error) throw new Error(apiErrorMessage(error, "Failed to load chat session context"));
  return data;
}

// ── History reload ────────────────────────────────────────────────────────

export type ChatTimeline = EdenData<ReturnType<typeof chat>["messages"]["get"]>;
export type PersistedChatEntry = ChatTimeline["entries"][number];

/** Fetch the persisted timeline for a PR's current head-SHA chat session. */
export async function fetchChatMessages(prId: string): Promise<ChatTimeline> {
  const { data, error } = await chat(prId).messages.get();
  if (error) throw new Error(apiErrorMessage(error, "Failed to fetch chat messages"));
  return data;
}

// ── Proposed changes ──────────────────────────────────────────────────────

export type ProposedChanges = EdenData<ReturnType<typeof chat>["proposed-changes"]["get"]>;

/** Fetch the list of commits the agent has made on top of the PR's head SHA. */
export async function fetchProposedChanges(prId: string): Promise<ProposedChanges> {
  const { data, error } = await chat(prId)["proposed-changes"].get();
  if (error) throw new Error(apiErrorMessage(error, "Failed to fetch proposed changes"));
  return data;
}

/**
 * Fetch full old/new file contents for a proposed commit. The diff modal
 * uses these with Pierre's `parseDiffFromFile`, which produces a
 * non-partial `FileDiffMetadata` — the prerequisite for the line-info
 * separator's expand-up / expand-down controls to be enabled.
 */
export async function fetchProposedDiffFiles(prId: string, sha: string) {
  const { data, error } = await chat(prId)["proposed-changes"]({ sha }).files.get();
  if (error) throw new Error(apiErrorMessage(error, `Failed to fetch files for ${sha}`));
  if (data.error !== undefined) throw new Error(data.error);
  return data.files;
}

export type ProposedDiffFile = Awaited<ReturnType<typeof fetchProposedDiffFiles>>[number];

// ── Merge & push ──────────────────────────────────────────────────────────

export type MergePushResult = EdenData<
  ReturnType<typeof chat>["proposed-changes"]["merge-and-push"]["post"]
>;

/** A refused push: the error table's code, or `GENERIC_ERROR` when the body carries none. */
export interface MergePushError {
  code: ApiErrorCode | "GENERIC_ERROR";
  message: string;
}

const MERGE_PUSH_OUTCOMES: ReadonlySet<unknown> = new Set<MergePushResult["status"]>([
  "pushed",
  "conflict",
  "remote-changed",
  "ref-exists",
]);

function isMergePushResult(value: unknown): value is MergePushResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    MERGE_PUSH_OUTCOMES.has(value.status)
  );
}

export interface PushProposedOptions {
  /** Push the agent's commits to a brand-new branch instead of merging into the PR's source branch. */
  newBranchName?: string;
  /** When `newBranchName` is set: force-push (overwrite an existing remote ref). Ignored otherwise. */
  force?: boolean;
}

/**
 * Attempt to merge the agent's local commits into the PR's source branch
 * and push. Returns a tagged result on success-ish outcomes (including
 * conflict + remote-changed); throws a structured MergePushError on hard
 * failures.
 *
 * When `options.newBranchName` is provided the server bypasses the merge
 * step and pushes the agent's local branch as-is to that new ref. If the
 * ref already exists remotely, the result is `{ status: 'ref-exists' }` so
 * the caller can confirm overwrite and retry with `force: true`.
 */
export async function pushProposedChanges(
  prId: string,
  options?: PushProposedOptions,
): Promise<MergePushResult> {
  const { data, error } = await chat(prId)["proposed-changes"]["merge-and-push"].post({
    ...(options?.newBranchName !== undefined ? { newBranchName: options.newBranchName } : {}),
    ...(options?.force !== undefined ? { force: options.force } : {}),
  });
  if (data) return data;
  // A conflict, a moved remote and an existing ref answer 409 with the result.
  if (error?.status === 409 && isMergePushResult(error.value)) return error.value;
  const refusal: MergePushError = {
    code: (error && apiErrorCode(error)) ?? "GENERIC_ERROR",
    message: error ? apiErrorMessage(error, "Push failed") : "Push failed",
  };
  throw refusal;
}

// ── Resolve & push (SSE) ──────────────────────────────────────────────────

export type ResolvePushFrame =
  | { kind: "status"; message: string }
  | { kind: "conflict-files"; files: string[] }
  | { kind: "agent-text"; data: string }
  | {
      kind: "agent-activity";
      activityKind: string;
      toolName: string | null;
      summary: string;
      payload?: unknown;
    }
  | {
      kind: "result";
      status: "pushed";
      newSha: string;
      pushedCommits: number;
      branch: string;
    }
  | { kind: "result"; status: "remote-changed"; branch: string }
  | { kind: "result"; status: "failed"; message: string };

export interface ResolvePushCallbacks {
  onStatus?: (message: string) => void;
  onConflictFiles?: (files: string[]) => void;
  onAgentText?: (chunk: string) => void;
  onAgentActivity?: (activity: {
    activityKind: string;
    toolName: string | null;
    summary: string;
    payload?: unknown;
  }) => void;
  onResult: (result: Extract<ResolvePushFrame, { kind: "result" }>) => void;
  onError: (error: StreamErrorBody) => void;
  onDone: () => void;
}

// ── Blocked-commit management ─────────────────────────────────────────────

/** Discard a single proposed commit via interactive rebase. */
export async function discardProposedCommit(prId: string, sha: string): Promise<void> {
  const { error } = await chat(prId)["proposed-changes"]({ sha }).delete();
  if (error) throw new Error(apiErrorMessage(error, "Failed"));
}

/** Rebase all agent commits onto a new head SHA. */
export async function rebaseProposedCommits(
  prId: string,
  oldHeadSha: string,
  newHeadSha: string,
): Promise<void> {
  const { error } = await chat(prId)["proposed-changes"]["rebase-onto"].post({
    oldHeadSha,
    newHeadSha,
  });
  if (error) throw new Error(apiErrorMessage(error, "Failed"));
}

/** After all blocked commits are handled, advance the worktree to the new PR head. */
export async function advanceWorktree(prId: string, newHeadSha: string): Promise<void> {
  const { error } = await chat(prId)["proposed-changes"].advance.post({ newHeadSha });
  if (error) throw new Error(apiErrorMessage(error, "Failed"));
}

/** Cherry-pick a single proposed commit onto the PR source branch and push. */
export async function cherryPickProposedCommit(prId: string, sha: string): Promise<void> {
  const { error } = await chat(prId)["proposed-changes"]["cherry-pick"].post({ sha });
  if (error) throw new Error(apiErrorMessage(error, "Failed"));
}

/** Cherry-pick N proposed commits onto the PR source branch and push once. */
export async function batchCherryPickProposedCommits(
  prId: string,
  shas: readonly string[],
): Promise<{ pushedCommits: number; branch: string }> {
  const { data, error } = await chat(prId)["proposed-changes"]["batch-cherry-pick"].post({
    shas,
  });
  if (error) throw new Error(apiErrorMessage(error, "Failed"));
  return { pushedCommits: data.pushedCommits ?? shas.length, branch: data.branch ?? "" };
}

/** Discard N proposed commits from the worktree atomically. */
export async function batchDiscardProposedCommits(
  prId: string,
  shas: readonly string[],
): Promise<{ discardedCount: number }> {
  const { data, error } = await chat(prId)["proposed-changes"]["batch-discard"].post({ shas });
  if (error) throw new Error(apiErrorMessage(error, "Failed"));
  return { discardedCount: data.discardedCount ?? shas.length };
}

/**
 * Stream the conflict-resolution + push flow. The agent's progress (file
 * edits, bash commands, brief commentary) is emitted inline; the terminal
 * frame describes the push outcome.
 */
export function resolveConflictsAndPush(
  prId: string,
  callbacks: ResolvePushCallbacks,
): AbortController {
  const controller = new AbortController();
  void settleAgentStream(
    streamSse<ResolvePushFrame>({
      path: `/api/chat/${prId}/proposed-changes/resolve-and-push`,
      method: "POST",
      signal: controller.signal,
      // The resolve-and-push stream sends no heartbeat, so a quiet agent step is normal.
      idleTimeoutMs: null,
      onEvent: (frame) => {
        switch (frame.kind) {
          case "status":
            callbacks.onStatus?.(frame.message);
            break;
          case "conflict-files":
            callbacks.onConflictFiles?.(frame.files);
            break;
          case "agent-text":
            callbacks.onAgentText?.(frame.data);
            break;
          case "agent-activity":
            callbacks.onAgentActivity?.({
              activityKind: frame.activityKind,
              toolName: frame.toolName,
              summary: frame.summary,
              ...(frame.payload !== undefined ? { payload: frame.payload } : {}),
            });
            break;
          case "result":
            callbacks.onResult(frame);
            break;
        }
      },
    }),
    callbacks,
  );
  return controller;
}
