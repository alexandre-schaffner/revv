// ── PendingQuestionRegistry ────────────────────────────────────────────────
//
// In-memory registry of pending `askUserQuestion` deferreds for the Claude
// driver. Required because the Claude Agent SDK's `canUseTool` callback
// returns a `PermissionResult` Promise; we keep the agent paused by holding
// the resolver until the user's answer arrives on
// `POST /api/chat/:prId/question/:questionId/answer`.
//
// Architecture notes
// ──────────────────
// • Keyed by `providerRequestId` (the SDK's `toolUseID`), which is globally
//   unique per SDK call. Same value persisted on `chat_questions.
//   provider_request_id`, so the answer endpoint pivots:
//     questionId → DB row → providerRequestId → in-memory deferred.
//
// • Module-scope singleton (`Map<providerRequestId, Deferred>`). Intentionally
//   non-Effect state — the resolvers/rejecters live in the Node process and
//   don't survive a restart. On boot, `supersedePendingQuestionsOnBoot()`
//   marks the orphaned DB rows so the empty registry is the right state.
//
// • Cleanup is owned by the *driver* (chat-claude.ts), which tracks the
//   providerRequestIds it has registered and calls `takePendingQuestion` +
//   reject for every entry on stream close/error so the SDK's `await
//   canUseTool` unwinds instead of hanging.
//
// • Opencode does NOT use this registry — its daemon owns the wait state and
//   we resolve via HTTP POST to `/question/{id}/reply`. Only claude rows
//   register here.

import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";

export interface PendingQuestionDeferred {
  readonly resolve: (result: PermissionResult) => void;
  readonly reject: (err: unknown) => void;
}

const registry = new Map<string, PendingQuestionDeferred>();

/**
 * Look up and remove the deferred. Returns null if the entry is gone (server
 * restarted, driver already cleaned up, or the answer was already submitted).
 *
 * NOTE: the ACP chat transport auto-allows tool permissions and does not bridge
 * `askUserQuestion`, so nothing currently registers deferreds here — this always
 * returns null until question-bridging lands. Kept so the answer endpoint stays
 * a safe no-op.
 */
export function takePendingQuestion(providerRequestId: string): PendingQuestionDeferred | null {
  const deferred = registry.get(providerRequestId);
  if (!deferred) return null;
  registry.delete(providerRequestId);
  return deferred;
}
