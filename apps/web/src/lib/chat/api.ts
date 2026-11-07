import type {
  Activity,
  ApiErrorCode,
  ChatAttachment,
  ChatSessionContext,
  ChatStreamFrame,
  ChatTask,
  InteractionMode,
  ResolvePushFrame,
  StreamErrorBody,
} from "@revv/shared";
import { api } from "$lib/api/client";
import { ApiError, call } from "$lib/api/errors";
import { sseError, streamSse } from "$lib/api/sse-stream";
import type { EdenData } from "$lib/api/wire";

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
    // The chat panel never surfaces model reasoning.
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
    const error = sseError(err, "The agent stream was refused");
    if (error) callbacks.onError(error);
    return;
  }
  callbacks.onDone();
}

function chat(prId: string) {
  return api.api.chat({ prId });
}

/** Clear the agent-side session and worktree+branch for this PR's chat. */
export async function clearChat(prId: string): Promise<void> {
  await call(chat(prId).delete(), "Failed to clear chat");
}

export async function setInteractionMode(prId: string, mode: InteractionMode): Promise<void> {
  await call(chat(prId)["interaction-mode"].patch({ mode }), "Failed to set interaction mode");
}

export async function approvePlan(prId: string, planId: string): Promise<void> {
  await call(chat(prId).plan({ planId }).approve.post(), "Approve failed");
}

export async function rejectPlan(prId: string, planId: string): Promise<void> {
  await call(chat(prId).plan({ planId }).reject.post(), "Reject failed");
}

export type AvailableAgents = EdenData<typeof api.api.chat.agents.available.get>;

export async function fetchAvailableAgents(): Promise<AvailableAgents> {
  const data = await call(api.api.chat.agents.available.get(), "Failed to load available agents");
  return data;
}

export async function fetchSessionContext(
  prId: string,
  opts: { warm?: boolean } = {},
): Promise<ChatSessionContext> {
  // `warm=1` opts into the server's eager path (acquire worktree + harvest slash
  // commands) so the `/`-command menu works on a brand-new chat. The plain fetch
  // stays side-effect-free.
  const data = await call(
    chat(prId)["session-context"].get({
      query: opts.warm ? { warm: "1" } : {},
    }),
    "Failed to load chat session context",
  );
  return data;
}

export type ChatTimeline = EdenData<ReturnType<typeof chat>["messages"]["get"]>;
export type PersistedChatEntry = ChatTimeline["entries"][number];

/** Fetch the persisted timeline for a PR's current head-SHA chat session. */
export async function fetchChatMessages(prId: string): Promise<ChatTimeline> {
  const data = await call(chat(prId).messages.get(), "Failed to fetch chat messages");
  return data;
}

export type ProposedChanges = EdenData<ReturnType<typeof chat>["proposed-changes"]["get"]>;

/** Fetch the list of commits the agent has made on top of the PR's head SHA. */
export async function fetchProposedChanges(prId: string): Promise<ProposedChanges> {
  const data = await call(chat(prId)["proposed-changes"].get(), "Failed to fetch proposed changes");
  return data;
}

/**
 * Fetch full old/new file contents for a proposed commit. The diff modal
 * uses these with Pierre's `parseDiffFromFile`, which produces a
 * non-partial `FileDiffMetadata` — the prerequisite for the line-info
 * separator's expand-up / expand-down controls to be enabled.
 */
export async function fetchProposedDiffFiles(prId: string, sha: string) {
  const data = await call(
    chat(prId)["proposed-changes"]({ sha }).files.get(),
    `Failed to fetch files for ${sha}`,
  );
  return [...data.files];
}

export type ProposedDiffFile = Awaited<ReturnType<typeof fetchProposedDiffFiles>>[number];

export type MergePushResult = EdenData<
  ReturnType<typeof chat>["proposed-changes"]["merge-and-push"]["post"]
>;

export interface MergePushError {
  code: ApiErrorCode | "GENERIC_ERROR";
  message: string;
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
  try {
    return await call(
      chat(prId)["proposed-changes"]["merge-and-push"].post({
        ...(options?.newBranchName !== undefined ? { newBranchName: options.newBranchName } : {}),
        ...(options?.force !== undefined ? { force: options.force } : {}),
      }),
      "Push failed",
    );
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    const refusal: MergePushError = { code: e.code ?? "GENERIC_ERROR", message: e.message };
    throw refusal;
  }
}

function notPushed(result: Exclude<MergePushResult, { status: "pushed" }>): Error {
  return new Error(
    result.status === "remote-changed"
      ? `The PR branch (${result.branch}) was updated remotely. Sync the latest changes and try again.`
      : `Nothing was pushed to ${result.branch}.`,
  );
}

export interface ResolvePushCallbacks {
  onStatus?: (message: string) => void;
  onConflictFiles?: (files: readonly string[]) => void;
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

/** Discard a single proposed commit via interactive rebase. */
export async function discardProposedCommit(prId: string, sha: string): Promise<void> {
  await call(chat(prId)["proposed-changes"]({ sha }).delete(), "Failed");
}

/** Rebase all agent commits onto a new head SHA. */
export async function rebaseProposedCommits(
  prId: string,
  oldHeadSha: string,
  newHeadSha: string,
): Promise<void> {
  await call(
    chat(prId)["proposed-changes"]["rebase-onto"].post({
      oldHeadSha,
      newHeadSha,
    }),
    "Failed",
  );
}

/** After all blocked commits are handled, advance the worktree to the new PR head. */
export async function advanceWorktree(prId: string, newHeadSha: string): Promise<void> {
  await call(chat(prId)["proposed-changes"].advance.post({ newHeadSha }), "Failed");
}

/** Cherry-pick a single proposed commit onto the PR source branch and push. */
export async function cherryPickProposedCommit(prId: string, sha: string): Promise<void> {
  const data = await call(chat(prId)["proposed-changes"]["cherry-pick"].post({ sha }), "Failed");
  if (data.status !== "pushed") throw notPushed(data);
}

/** Cherry-pick N proposed commits onto the PR source branch and push once. */
export async function batchCherryPickProposedCommits(
  prId: string,
  shas: readonly string[],
): Promise<{ pushedCommits: number; branch: string }> {
  const data = await call(
    chat(prId)["proposed-changes"]["batch-cherry-pick"].post({
      shas: [...shas],
    }),
    "Failed",
  );
  if (data.status !== "pushed") throw notPushed(data);
  return { pushedCommits: data.pushedCommits, branch: data.branch };
}

/** Discard N proposed commits from the worktree atomically. */
export async function batchDiscardProposedCommits(
  prId: string,
  shas: readonly string[],
): Promise<{ discardedCount: number }> {
  const data = await call(
    chat(prId)["proposed-changes"]["batch-discard"].post({
      shas: [...shas],
    }),
    "Failed",
  );
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
