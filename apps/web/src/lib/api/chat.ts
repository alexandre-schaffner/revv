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
  ActivityKind,
  ChatPlan,
  ChatQuestion,
  ChatStreamFrame,
  ChatSubagentInvocation,
  ChatTask,
  InteractionMode,
  NormalizedQuestion,
  NormalizedQuestionOption,
} from "@revv/shared";
import { API_BASE_URL } from "$lib/api/base-url";
import { authHeaders } from "$lib/utils/session-token";
import { parseSSEBuffer } from "$lib/utils/sse-parser";

// Re-export activity types used by stores and components.
export type {
  Activity,
  ActivityKind,
  ChatTask,
  InteractionMode,
  NormalizedQuestion,
  NormalizedQuestionOption,
};

export interface ChatRequestParams {
  prId: string;
  message: string;
  interactionMode?: InteractionMode;
  approvedPlanId?: string;
}

export interface ChatCallbacks {
  onText: (chunk: string) => void;
  onActivity: (activity: Activity & { subagentInvocationId?: string }) => void;
  onTaskList: (params: { turnId: string; tasks: ReadonlyArray<ChatTask> }) => void;
  onPlanPresented: (params: { planId: string; turnId: string; markdown: string }) => void;
  onSubagentStart: (params: {
    invocationId: string;
    parentTurnId: string;
    subagentType: string;
    description: string;
  }) => void;
  onSubagentEnd: (params: { invocationId: string; result: string; ok: boolean }) => void;
  onQuestionPosted: (params: {
    questionId: string;
    turnId: string;
    questions: ReadonlyArray<NormalizedQuestion>;
    previewFormat: "markdown" | "html";
  }) => void;
  onQuestionResolved: (params: {
    questionId: string;
    status: "answered" | "rejected";
    answers?: Readonly<Record<string, ReadonlyArray<string>>>;
  }) => void;
  onDone: () => void;
  onError: (error: { code: string; message: string; [k: string]: unknown }) => void;
}

/**
 * No-bytes inactivity timeout for the chat SSE — the transport is considered
 * dead and we fire `onError` so the Stop button can clear.
 *
 * The server sends `: keepalive` every 15s (see `chatStreamToSSE` in
 * apps/server/src/routes/middleware.ts), so this only trips when even
 * heartbeats have stopped flowing — i.e. the connection is genuinely dead,
 * not just the model thinking. Without this guard, a silent close (server
 * crash mid-turn, OS reclaiming the WKWebView socket) leaves `reader.read()`
 * blocked forever and `setStreaming(false)` is never called, so the Stop
 * button stays rendered after the agent is effectively gone.
 */
const CHAT_INACTIVITY_TIMEOUT_MS = 90 * 1000;

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

  // Watchdog timer: resets on every byte from the server. Fires once if no
  // data arrives for `CHAT_INACTIVITY_TIMEOUT_MS` — aborts the fetch so the
  // `.catch` below converts it into a structured NETWORK_ERROR. The
  // `inactivityTripped` flag lets the catch distinguish "we aborted" from a
  // user-driven AbortController.abort() (both surface as AbortError, but the
  // user case should stay silent — abortChatTurn already finalized the UI).
  let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
  let inactivityTripped = false;
  const armInactivity = (): void => {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
      inactivityTripped = true;
      controller.abort();
    }, CHAT_INACTIVITY_TIMEOUT_MS);
  };
  const disarmInactivity = (): void => {
    if (inactivityTimer) {
      clearTimeout(inactivityTimer);
      inactivityTimer = undefined;
    }
  };

  armInactivity();

  fetch(`${API_BASE_URL}/api/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify({
      prId: params.prId,
      message: params.message,
      ...(params.interactionMode !== undefined ? { interactionMode: params.interactionMode } : {}),
      ...(params.approvedPlanId !== undefined ? { approvedPlanId: params.approvedPlanId } : {}),
    }),
    signal: controller.signal,
  })
    .then(async (res) => {
      if (!res.ok) {
        disarmInactivity();
        const body = await res.json().catch(() => ({ code: "UNKNOWN", message: res.statusText }));
        callbacks.onError(body as { code: string; message: string });
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) {
        disarmInactivity();
        callbacks.onError({ code: "NO_BODY", message: "No response body" });
        return;
      }

      const decoder = new TextDecoder();
      let buffer = "";
      let gotError = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        // Any bytes from the server — including `: keepalive` heartbeats
        // stripped by the SSE parser as comments — prove the transport
        // is alive. Reset the watchdog so it only trips on a genuinely
        // dead connection.
        if (value && value.byteLength > 0) {
          armInactivity();
        }

        buffer += decoder.decode(value, { stream: true });

        const result = parseSSEBuffer<ChatStreamFrame>(buffer);
        buffer = result.remaining;

        if (result.error) {
          callbacks.onError(result.error);
          gotError = true;
          continue;
        }

        for (const frame of result.events) {
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
              ...(frame.subagentInvocationId !== undefined
                ? { subagentInvocationId: frame.subagentInvocationId }
                : {}),
            });
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
          } else if (frame.kind === "subagent-start") {
            callbacks.onSubagentStart({
              invocationId: frame.invocationId,
              parentTurnId: frame.parentTurnId,
              subagentType: frame.subagentType,
              description: frame.description,
            });
          } else if (frame.kind === "subagent-end") {
            callbacks.onSubagentEnd({
              invocationId: frame.invocationId,
              result: frame.result,
              ok: frame.ok,
            });
          } else if (frame.kind === "user-question") {
            callbacks.onQuestionPosted({
              questionId: frame.questionId,
              turnId: frame.turnId,
              questions: frame.questions,
              previewFormat: frame.previewFormat,
            });
          } else if (frame.kind === "user-question-resolved") {
            callbacks.onQuestionResolved({
              questionId: frame.questionId,
              status: frame.status,
              ...(frame.answers !== undefined ? { answers: frame.answers } : {}),
            });
          }
        }

        if (result.done) {
          disarmInactivity();
          callbacks.onDone();
          return;
        }
      }

      disarmInactivity();
      if (!gotError) {
        callbacks.onDone();
      }
    })
    .catch((err: Error) => {
      disarmInactivity();
      // Inactivity watchdog tripped — surface as a structured error so
      // the chat store clears `isStreaming` and the Stop button hides.
      if (inactivityTripped) {
        callbacks.onError({
          code: "NETWORK_ERROR",
          message:
            "Lost connection to the local server. The agent may have stopped — check the server logs and try again.",
        });
        return;
      }
      if (err.name !== "AbortError") {
        // WebKit surfaces connection drops as "Load failed"; Chromium as "Failed to fetch".
        // Both mean the local server closed the connection unexpectedly.
        const isConnectionDrop = err.message === "Load failed" || err.message === "Failed to fetch";
        callbacks.onError({
          code: "NETWORK_ERROR",
          message: isConnectionDrop
            ? "Lost connection to the local server. The agent may have stopped — check the server logs and try again."
            : err.message,
        });
      }
    });

  return controller;
}

/** Clear the agent-side session and worktree+branch for this PR's chat. */
export async function clearChat(prId: string): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/api/chat/${prId}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok && res.status !== 204) {
    throw new Error(`Failed to clear chat: ${res.status}`);
  }
}

// ── Plan / interaction-mode endpoints ─────────────────────────────────────

export async function setInteractionMode(prId: string, mode: InteractionMode): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/api/chat/${prId}/interaction-mode`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ mode }),
  });
  if (!res.ok) {
    throw new Error(`Failed to set interaction mode: ${res.status}`);
  }
}

export async function approvePlan(prId: string, planId: string): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/api/chat/${prId}/plan/${planId}/approve`, {
    method: "POST",
    headers: authHeaders(),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    throw new Error((body.message as string | undefined) ?? `Approve failed: ${res.status}`);
  }
}

export async function rejectPlan(prId: string, planId: string): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/api/chat/${prId}/plan/${planId}/reject`, {
    method: "POST",
    headers: authHeaders(),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    throw new Error((body.message as string | undefined) ?? `Reject failed: ${res.status}`);
  }
}

export interface SubmitQuestionAnswerParams {
  decision: "answer" | "reject";
  answers?: Record<string, ReadonlyArray<string>>;
  customAnswers?: Record<string, string>;
}

export interface SubmitQuestionAnswerResult {
  status: "ok";
  resolution: "answered" | "rejected";
  alreadyResolved?: boolean;
  /** If a pending plan was auto-superseded because the conversation moved past it, its id. */
  supersededPlanId?: string;
}

export interface SubmitQuestionAnswerError {
  code: "QUESTION_NOT_FOUND" | "QUESTION_EXPIRED" | "OPENCODE_UNAVAILABLE" | "GENERIC_ERROR";
  message: string;
}

/**
 * Submit the user's answer (or rejection) to an open question. Server is
 * idempotent: if the row is already resolved, the response carries
 * `alreadyResolved: true` and the same resolution. The store treats both
 * paths the same way (patch local item to terminal state).
 */
export async function submitQuestionAnswer(
  prId: string,
  questionId: string,
  params: SubmitQuestionAnswerParams,
): Promise<SubmitQuestionAnswerResult> {
  const res = await fetch(`${API_BASE_URL}/api/chat/${prId}/question/${questionId}/answer`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(params),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const err: SubmitQuestionAnswerError = {
      code: (body.code as SubmitQuestionAnswerError["code"]) ?? "GENERIC_ERROR",
      message: (body.message as string | undefined) ?? `Submit failed: ${res.status}`,
    };
    throw err;
  }
  return {
    status: "ok",
    resolution: body.resolution as "answered" | "rejected",
    ...(body.alreadyResolved === true ? { alreadyResolved: true } : {}),
    ...(typeof body.supersededPlanId === "string"
      ? { supersededPlanId: body.supersededPlanId }
      : {}),
  };
}

export interface AvailableAgents {
  agent: "claude" | "opencode";
  agents: readonly string[];
  planAvailable: boolean;
}

export async function fetchAvailableAgents(): Promise<AvailableAgents> {
  const res = await fetch(`${API_BASE_URL}/api/chat/agents/available`, {
    headers: authHeaders(),
  });
  if (!res.ok) {
    throw new Error(`Failed to load available agents: ${res.status}`);
  }
  return (await res.json()) as AvailableAgents;
}

// ── History reload ────────────────────────────────────────────────────────

export interface PersistedChatMessage {
  entryKind: "message";
  id: string;
  chatSessionId: string;
  role: "user" | "assistant";
  content: string;
  isStreaming: boolean;
  sequence: number;
  turnId: string;
  error: string | null;
  createdAt: string;
  finalizedAt: string | null;
}

export interface PersistedChatActivity {
  entryKind: "activity";
  id: string;
  chatSessionId: string;
  turnId: string;
  activityKind: string;
  toolName: string | null;
  summary: string;
  payloadJson: string | null;
  sequence: number;
  subagentInvocationId: string | null;
  createdAt: string;
}

export interface PersistedChatTaskList {
  entryKind: "task-list";
  turnId: string;
  sequence: number;
  tasks: ReadonlyArray<ChatTask>;
}

export interface PersistedChatPlan {
  entryKind: "plan";
  id: string;
  chatSessionId: string;
  turnId: string;
  planMarkdown: string;
  status: "pending" | "approved" | "rejected" | "superseded";
  source: "claude" | "opencode";
  sequence: number;
  createdAt: string;
  decidedAt: string | null;
}

export interface PersistedChatSubagent {
  entryKind: "subagent";
  id: string;
  chatSessionId: string;
  parentTurnId: string;
  providerCallId: string;
  subagentType: string;
  description: string;
  prompt: string;
  status: "running" | "completed" | "errored";
  result: string | null;
  source: "claude" | "opencode";
  sequence: number;
  startedAt: string;
  completedAt: string | null;
}

export interface PersistedChatQuestion {
  entryKind: "question";
  id: string;
  chatSessionId: string;
  turnId: string;
  source: "claude" | "opencode";
  providerRequestId: string;
  providerToolCallId: string | null;
  previewFormat: "markdown" | "html";
  questions: ReadonlyArray<NormalizedQuestion>;
  status: "pending" | "answered" | "rejected" | "superseded";
  answers: Readonly<Record<string, ReadonlyArray<string>>> | null;
  customAnswers: Readonly<Record<string, string>> | null;
  sequence: number;
  createdAt: string;
  answeredAt: string | null;
}

export type PersistedChatEntry =
  | PersistedChatMessage
  | PersistedChatActivity
  | PersistedChatTaskList
  | PersistedChatPlan
  | PersistedChatSubagent
  | PersistedChatQuestion;

export interface ChatTimeline {
  chatSessionId: string | null;
  entries: PersistedChatEntry[];
  interactionMode: InteractionMode;
}

/** Fetch the persisted timeline for a PR's current head-SHA chat session. */
export async function fetchChatMessages(prId: string): Promise<ChatTimeline> {
  const res = await fetch(`${API_BASE_URL}/api/chat/${prId}/messages`, {
    headers: authHeaders(),
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch chat messages: ${res.status}`);
  }
  return (await res.json()) as ChatTimeline;
}

// ── Proposed changes ──────────────────────────────────────────────────────

export interface ProposedCommit {
  sha: string;
  shortSha: string;
  subject: string;
  committedAt: string;
  files: string[];
}

export interface ProposedChanges {
  branchName: string | null;
  prHeadSha: string | null;
  commits: ProposedCommit[];
}

/** Fetch the list of commits the agent has made on top of the PR's head SHA. */
export async function fetchProposedChanges(prId: string): Promise<ProposedChanges> {
  const res = await fetch(`${API_BASE_URL}/api/chat/${prId}/proposed-changes`, {
    headers: authHeaders(),
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch proposed changes: ${res.status}`);
  }
  return (await res.json()) as ProposedChanges;
}

export interface ProposedDiffFile {
  path: string;
  oldPath: string | null;
  oldContent: string | null;
  newContent: string | null;
  status: string;
  binary: boolean;
}

/**
 * Fetch full old/new file contents for a proposed commit. The diff modal
 * uses these with Pierre's `parseDiffFromFile`, which produces a
 * non-partial `FileDiffMetadata` — the prerequisite for the line-info
 * separator's expand-up / expand-down controls to be enabled.
 */
export async function fetchProposedDiffFiles(
  prId: string,
  sha: string,
): Promise<ProposedDiffFile[]> {
  const res = await fetch(`${API_BASE_URL}/api/chat/${prId}/proposed-changes/${sha}/files`, {
    headers: authHeaders(),
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch files for ${sha}: ${res.status}`);
  }
  const data = (await res.json()) as {
    files?: ProposedDiffFile[];
    error?: string;
  };
  if (data.error) throw new Error(data.error);
  return data.files ?? [];
}

// ── Merge & push ──────────────────────────────────────────────────────────

export type MergePushResult =
  | {
      status: "pushed";
      newSha: string;
      pushedCommits: number;
      branch: string;
    }
  | { status: "conflict"; files: string[]; branch: string }
  | { status: "remote-changed"; branch: string }
  | { status: "ref-exists"; branch: string };

export interface MergePushError {
  code:
    | "CONCURRENT_PUSH"
    | "CHAT_STREAMING"
    | "DIRTY_WORKTREE"
    | "NO_CHANGES"
    | "NO_CHAT_SESSION"
    | "PUSH_REJECTED"
    | "INVALID_BRANCH_NAME"
    | "REF_EXISTS"
    | "GENERIC_ERROR";
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
  const headers: Record<string, string> = { ...authHeaders() };
  let bodyJson: string | undefined;
  if (options && (options.newBranchName !== undefined || options.force !== undefined)) {
    headers["Content-Type"] = "application/json";
    bodyJson = JSON.stringify({
      ...(options.newBranchName !== undefined ? { newBranchName: options.newBranchName } : {}),
      ...(options.force !== undefined ? { force: options.force } : {}),
    });
  }
  const res = await fetch(`${API_BASE_URL}/api/chat/${prId}/proposed-changes/merge-and-push`, {
    method: "POST",
    headers,
    ...(bodyJson !== undefined ? { body: bodyJson } : {}),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;

  // 200 / 409: body is the structured result.
  if (res.ok || res.status === 409) {
    const status = body.status;
    if (status === "pushed") {
      return {
        status: "pushed",
        newSha: String(body.newSha),
        pushedCommits: Number(body.pushedCommits ?? 0),
        branch: String(body.branch),
      };
    }
    if (status === "conflict") {
      return {
        status: "conflict",
        files: Array.isArray(body.files) ? (body.files as string[]) : [],
        branch: String(body.branch),
      };
    }
    if (status === "remote-changed") {
      return {
        status: "remote-changed",
        branch: String(body.branch),
      };
    }
    if (status === "ref-exists") {
      return {
        status: "ref-exists",
        branch: String(body.branch),
      };
    }
  }

  // Otherwise it's a structured error.
  const code = (body.code as MergePushError["code"]) ?? "GENERIC_ERROR";
  const message =
    (body.message as string) ?? (body.error as string) ?? `Push failed (${res.status})`;
  const err: MergePushError = { code, message };
  throw err;
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
  onError: (error: { code: string; message: string }) => void;
  onDone: () => void;
}

// ── Blocked-commit management ─────────────────────────────────────────────

/** Discard a single proposed commit via interactive rebase. */
export async function discardProposedCommit(prId: string, sha: string): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/api/chat/${prId}/proposed-changes/${sha}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: "Unknown error" }))) as Record<
      string,
      unknown
    >;
    throw new Error(
      (body.error as string | undefined) ??
        (body.message as string | undefined) ??
        `Failed: ${res.status}`,
    );
  }
}

/** Rebase all agent commits onto a new head SHA. */
export async function rebaseProposedCommits(
  prId: string,
  oldHeadSha: string,
  newHeadSha: string,
): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/api/chat/${prId}/proposed-changes/rebase-onto`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ oldHeadSha, newHeadSha }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: "Unknown error" }))) as Record<
      string,
      unknown
    >;
    throw new Error(
      (body.error as string | undefined) ??
        (body.message as string | undefined) ??
        `Failed: ${res.status}`,
    );
  }
}

/** After all blocked commits are handled, advance the worktree to the new PR head. */
export async function advanceWorktree(prId: string, newHeadSha: string): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/api/chat/${prId}/proposed-changes/advance`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ newHeadSha }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: "Unknown error" }))) as Record<
      string,
      unknown
    >;
    throw new Error(
      (body.error as string | undefined) ??
        (body.message as string | undefined) ??
        `Failed: ${res.status}`,
    );
  }
}

/** Cherry-pick a single proposed commit onto the PR source branch and push. */
export async function cherryPickProposedCommit(prId: string, sha: string): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/api/chat/${prId}/proposed-changes/cherry-pick`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ sha }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: "Unknown error" }))) as Record<
      string,
      unknown
    >;
    throw new Error(
      (body.error as string | undefined) ??
        (body.message as string | undefined) ??
        `Failed: ${res.status}`,
    );
  }
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

  fetch(`${API_BASE_URL}/api/chat/${prId}/proposed-changes/resolve-and-push`, {
    method: "POST",
    headers: authHeaders(),
    signal: controller.signal,
  })
    .then(async (res) => {
      if (!res.ok) {
        const body = await res.json().catch(() => ({ code: "UNKNOWN", message: res.statusText }));
        callbacks.onError(body as { code: string; message: string });
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) {
        callbacks.onError({ code: "NO_BODY", message: "No response body" });
        return;
      }

      const decoder = new TextDecoder();
      let buffer = "";
      let gotError = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        const result = parseSSEBuffer<ResolvePushFrame>(buffer);
        buffer = result.remaining;

        if (result.error) {
          callbacks.onError(result.error);
          gotError = true;
          continue;
        }

        for (const frame of result.events) {
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
        }

        if (result.done) {
          callbacks.onDone();
          return;
        }
      }

      if (!gotError) {
        callbacks.onDone();
      }
    })
    .catch((err: Error) => {
      if (err.name !== "AbortError") {
        // WebKit surfaces connection drops as "Load failed"; Chromium as "Failed to fetch".
        // Both mean the local server closed the connection unexpectedly.
        const isConnectionDrop = err.message === "Load failed" || err.message === "Failed to fetch";
        callbacks.onError({
          code: "NETWORK_ERROR",
          message: isConnectionDrop
            ? "Lost connection to the local server. The agent may have stopped — check the server logs and try again."
            : err.message,
        });
      }
    });

  return controller;
}
