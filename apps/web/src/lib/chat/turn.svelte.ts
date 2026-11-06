// Chat turns: sending a message and writing the agent's answer into the
// timeline as it streams, stopping it, plan decisions, the send queue, and the
// PR-level actions that span the chat modules (open, reload, clear, reset).

import {
  attachmentByteSize,
  type ChatAttachment,
  type InteractionMode,
  type ProposedCommit,
} from "@revv/shared";
import { untrack } from "svelte";
import { toast } from "svelte-sonner";
import { openSettings } from "$lib/stores/settingsModal.svelte";
import { agentAuthRecoveryDescription } from "$lib/utils/agent-auth-recovery";
import {
  approvePlan,
  clearChat,
  rejectPlan,
  setInteractionMode as setInteractionModeApi,
  streamChatMessage,
} from "./api";
import {
  clearProposed,
  clearProposedComments,
  getProposedComments,
  refreshProposedChanges,
  reset as resetProposed,
  setWorktreeBlocked,
} from "./proposed.svelte";
import {
  clearQueuedMessages,
  queueMessage,
  reset as resetQueue,
  takeQueuedMessage,
} from "./queue.svelte";
import {
  loadChatSessionContext,
  refreshChatSessionContext,
  reset as resetSession,
} from "./session.svelte";
import { reset as resetSuggestions } from "./suggestions.svelte";
import {
  appendItem,
  clearTimeline,
  getInteractionMode,
  isChatStreaming,
  loadChatHistory,
  patchActivity,
  reloadChatHistory,
  reset as resetTimeline,
  sealStreamingBubble,
  setActiveTurn,
  setInteractionModeLocally,
  setPlanStatus,
  setTaskList,
  type TurnWriter,
  writeTurn,
} from "./timeline.svelte";

const controllers = new Map<string, AbortController>();

function stopStream(prId: string): void {
  controllers.get(prId)?.abort();
  controllers.delete(prId);
}

/** Load what the chat panel shows for a PR; safe to call from an effect. */
export function openChat(prId: string): void {
  untrack(() => {
    void refreshProposedChanges(prId);
    loadChatHistory(prId);
    loadChatSessionContext(prId);
  });
}

export interface SendChatMessageParams {
  prId: string;
  message: string;
  /** The plan this message approves; the server leaves plan mode for the turn. */
  approvedPlanId?: string;
  interactionMode?: InteractionMode;
  attachments?: ReadonlyArray<ChatAttachment>;
}

/** Start a turn, cancelling the one in flight. */
export function sendChatMessage(params: SendChatMessageParams): void {
  const { prId, message, approvedPlanId, interactionMode, attachments = [] } = params;
  const text = message.trim();
  if (text.length === 0 && attachments.length === 0) return;

  stopStream(prId);
  const turnId = crypto.randomUUID();
  appendItem(prId, {
    kind: "message",
    id: crypto.randomUUID(),
    role: "user",
    content: text,
    isStreaming: false,
    attachments: attachments.map((a) => ({
      kind: a.kind,
      name: a.name,
      mimeType: a.mimeType,
      size: attachmentByteSize(a),
    })),
    turnId,
  });
  const turn = writeTurn(prId, turnId);
  setActiveTurn(prId, turnId);

  const controller = streamChatMessage(
    {
      prId,
      message: text,
      attachments,
      ...(approvedPlanId !== undefined ? { approvedPlanId } : {}),
      ...(interactionMode !== undefined ? { interactionMode } : {}),
    },
    {
      onText: (chunk) => turn.text(chunk),
      onActivity: (activity) =>
        turn.row({
          kind: "activity",
          id: crypto.randomUUID(),
          activityKind: activity.activityKind,
          toolName: activity.toolName,
          summary: activity.summary,
          turnId,
          ...(activity.payload !== undefined ? { payload: activity.payload } : {}),
          ...(activity.callId !== undefined ? { callId: activity.callId } : {}),
        }),
      onActivityResult: ({ callId, output, isError }) =>
        patchActivity(prId, callId, { output, isError }),
      // Some agents send an empty tool call first and its input later.
      onActivityInput: ({ callId, payload }) => patchActivity(prId, callId, { payload }),
      onTaskList: ({ turnId: taskTurnId, tasks }) => setTaskList(prId, taskTurnId, tasks),
      onPlanPresented: ({ planId, turnId: planTurnId, markdown }) =>
        turn.row({ kind: "plan", id: planId, turnId: planTurnId, markdown, status: "pending" }),
      onDone: () => {
        endTurn(prId, turn);
        void refreshProposedChanges(prId);
        refreshChatSessionContext(prId);
        sendNextQueued(prId);
      },
      onError: (err) => {
        if (err.code === "PLAN_PENDING") {
          endTurn(prId, turn);
          toast.error("Approve or reject the open plan before sending a new message.");
          return;
        }
        if (err.code === "WORKTREE_BLOCKED") {
          // Refused before the agent ran: show the blocked commits instead.
          setWorktreeBlocked(prId, {
            oldHeadSha: typeof err.oldHeadSha === "string" ? err.oldHeadSha : "",
            newHeadSha: typeof err.newHeadSha === "string" ? err.newHeadSha : "",
            commits: Array.isArray(err.commits) ? (err.commits as ProposedCommit[]) : [],
          });
          endTurn(prId, turn);
          return;
        }
        endTurn(prId, turn, err.message);
        // The agent may have committed before the stream failed.
        void refreshProposedChanges(prId);
        toastTurnError(err);
      },
    },
  );
  controllers.set(prId, controller);
}

function endTurn(prId: string, turn: TurnWriter, error?: string): void {
  turn.seal(error);
  setActiveTurn(prId, null);
  controllers.delete(prId);
}

function toastTurnError(err: { code: string; message: string }): void {
  const openAiSettings = { label: "Open Settings", onClick: () => openSettings("ai") };
  if (err.code === "NOT_CONFIGURED") {
    toast.error("AI agent not configured", {
      description: "Reconnect the agent in Settings, then retry.",
      action: openAiSettings,
      duration: Number.POSITIVE_INFINITY,
    });
  } else if (err.code === "GITHUB_RATE_LIMITED") {
    toast.error("GitHub rate limit reached", { description: err.message, duration: 15000 });
  } else if (err.code === "AGENT_AUTH_REQUIRED") {
    toast.error("AI agent authentication required", {
      description: agentAuthRecoveryDescription(err.message),
      action: openAiSettings,
      duration: Number.POSITIVE_INFINITY,
    });
  } else {
    toast.error(err.message || "AI chat failed");
  }
}

/** Send now, or queue behind the turn in flight. */
export function submitChatMessage(
  prId: string,
  text: string,
  attachments: ReadonlyArray<ChatAttachment>,
): void {
  const message = text.trim();
  if (message.length === 0 && attachments.length === 0) return;
  if (isChatStreaming(prId)) queueMessage(prId, message, attachments);
  else sendChatMessage({ prId, message, attachments });
}

function sendNextQueued(prId: string): void {
  const next = takeQueuedMessage(prId);
  if (next) sendChatMessage({ prId, message: next.text, attachments: next.attachments });
}

/**
 * Stop the turn in flight, keeping what it already streamed. Runs even with no
 * controller: a streaming flag can outlive it (a module reload drops the map),
 * and Stop must always get the user unstuck.
 */
export function abortChatTurn(prId: string): void {
  stopStream(prId);
  sealStreamingBubble(prId, "Stopped");
  setActiveTurn(prId, null);
  // The agent may have committed before it was stopped.
  void refreshProposedChanges(prId);
}

// ── Plan mode ──────────────────────────────────────────────────────────────

export async function setInteractionMode(prId: string, mode: InteractionMode): Promise<void> {
  const prior = getInteractionMode(prId);
  setInteractionModeLocally(prId, mode);
  try {
    await setInteractionModeApi(prId, mode);
  } catch (err) {
    setInteractionModeLocally(prId, prior);
    toast.error(err instanceof Error ? err.message : "Failed to set interaction mode");
  }
}

export async function approvePlanAction(prId: string, planId: string): Promise<void> {
  try {
    await approvePlan(prId, planId);
  } catch (err) {
    toast.error(err instanceof Error ? err.message : "Approve failed");
    return;
  }
  setPlanStatus(prId, planId, "approved");
  // The server leaves plan mode for the execution turn.
  setInteractionModeLocally(prId, "default");
  sendChatMessage({
    prId,
    message: "Proceed with the plan above.",
    approvedPlanId: planId,
    interactionMode: "default",
  });
}

export async function rejectPlanAction(prId: string, planId: string): Promise<void> {
  try {
    await rejectPlan(prId, planId);
    setPlanStatus(prId, planId, "rejected");
  } catch (err) {
    toast.error(err instanceof Error ? err.message : "Reject failed");
  }
}

/**
 * Send the comments left on a proposed commit to the agent as one message.
 * Returns false when there were none.
 */
export function sendProposedFeedback(params: {
  prId: string;
  sha: string;
  subject: string;
}): boolean {
  const { prId, sha, subject } = params;
  const comments = getProposedComments(prId, sha);
  if (comments.length === 0) return false;
  const header = `Reviewer feedback on commit \`${sha.slice(0, 8)}\` — "${subject}":`;
  const lines = comments.map(
    (c) =>
      `- **${c.filePath}:${c.lineNumber}** (${c.side === "deletions" ? "old" : "new"}) — ${c.body}`,
  );
  sendChatMessage({ prId, message: [header, "", ...lines].join("\n") });
  clearProposedComments(prId, sha);
  return true;
}

// ── PR-level ───────────────────────────────────────────────────────────────

/**
 * After a pull: the server keys the chat session on the PR head, so re-read
 * the timeline for the new head (empty until the next message).
 */
export function reloadChatForNewHead(prId: string): void {
  stopStream(prId);
  setActiveTurn(prId, null);
  reloadChatHistory(prId);
}

/** Clear the conversation, its agent session and its working branch. */
export async function clearChatHistory(prId: string): Promise<void> {
  stopStream(prId);
  clearTimeline(prId);
  clearProposed(prId);
  clearQueuedMessages(prId);
  try {
    await clearChat(prId);
  } catch (err) {
    toast.error(err instanceof Error ? err.message : "Failed to clear conversation");
  }
}

/**
 * Forget every PR's chat state and stop listening to streams in flight (they
 * finish server-side and land in the persisted timeline).
 */
export function reset(): void {
  for (const controller of controllers.values()) controller.abort();
  controllers.clear();
  resetTimeline();
  resetProposed();
  resetSession();
  resetQueue();
  resetSuggestions();
}
