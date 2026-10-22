// ── Chat types ───────────────────────────────────────────────────────────────
//
// Shared types for the right-pane chat's three structured surfaces:
// task lists (TodoWrite / opencode todos), plans (ExitPlanMode / plan agent),
// and sub-agent invocations (Task tool / opencode AgentPart).
//
// These shapes are the wire-level contract between the Elysia server and the
// SvelteKit frontend, and the persistence shape in `chat_tasks`,
// `chat_plans`, and `chat_subagent_invocations` mirrors them 1:1.

/**
 * Session-level interaction toggle. Borrows the t3code naming so semantics
 * are easy to look up. `plan` flips the underlying driver into plan-mode for
 * every turn in the session until either the user toggles back to `default`
 * or a plan-approval flow auto-flips.
 */
export type InteractionMode = "default" | "plan";

/**
 * One row from the agent's running todo list. Snapshot semantics: providers
 * emit the full list each update; the server upserts in place keyed on
 * `taskId` so the client can re-render diff-free.
 */
export interface ChatTask {
  readonly id: string;
  readonly content: string;
  readonly activeForm: string | null;
  readonly status: "pending" | "in_progress" | "completed";
  readonly priority: "low" | "medium" | "high" | null;
}

/**
 * A plan emitted by the agent in plan mode. Status reflects user decision
 * — plans never auto-transition.
 */
export interface ChatPlan {
  readonly id: string;
  readonly turnId: string;
  readonly planMarkdown: string;
  readonly status: "pending" | "approved" | "rejected" | "superseded";
  readonly source: "acp";
  readonly createdAt: string;
  readonly decidedAt: string | null;
}

/**
 * One sub-agent invocation. The UI renders this as a collapsible card; all
 * `Activity` rows whose `subagentInvocationId === id` get grouped under it.
 */
export interface ChatSubagentInvocation {
  readonly id: string;
  readonly parentTurnId: string;
  readonly subagentType: string;
  readonly description: string;
  readonly prompt: string;
  readonly status: "running" | "completed" | "errored";
  readonly result: string | null;
  readonly source: "acp";
  readonly startedAt: string;
  readonly completedAt: string | null;
}

/**
 * One option in a multiple-choice question prompt. Shared by both providers
 * (Claude `askUserQuestion`, opencode `question.asked`). `preview` carries
 * optional markdown/HTML content the renderer can disclose under the
 * label/description pair — Claude-only today; opencode always omits it.
 */
export interface NormalizedQuestionOption {
  readonly label: string;
  readonly description: string;
  readonly preview?: string;
}

/**
 * One question in a question-tool invocation. The agent may ask 1–4 such
 * questions in a single tool call (Claude) or 1+ (opencode).
 *
 * `multiSelect` matches Claude's flag; opencode's `multiple` maps onto it.
 * `allowCustom` is opencode's `custom` flag — Claude has no equivalent, so
 * the claude path always normalizes this to `false`.
 */
export interface NormalizedQuestion {
  readonly question: string;
  readonly header: string;
  readonly multiSelect: boolean;
  readonly allowCustom: boolean;
  readonly options: ReadonlyArray<NormalizedQuestionOption>;
}

/**
 * A pending or resolved interactive question from the agent. Renders as a
 * card with selectable options in the chat panel.
 *
 * Status lifecycle:
 *   - 'pending'    — emitted by agent, awaiting user decision
 *   - 'answered'   — user chose options (+ optional custom text)
 *   - 'rejected'   — user dismissed the prompt
 *   - 'superseded' — stream died before the user could answer (e.g.
 *                    server restart); the agent will need to re-ask
 */
export interface ChatQuestion {
  readonly id: string;
  readonly turnId: string;
  readonly providerRequestId: string;
  readonly source: "acp";
  readonly questions: ReadonlyArray<NormalizedQuestion>;
  readonly status: "pending" | "answered" | "rejected" | "superseded";
  /** Map question text → labels chosen. Null when status === 'pending'. */
  readonly answers: Readonly<Record<string, ReadonlyArray<string>>> | null;
  /** Map question text → user's free-text answer (opencode `allowCustom`). */
  readonly customAnswers: Readonly<Record<string, string>> | null;
  readonly previewFormat: "markdown" | "html";
  readonly createdAt: string;
  readonly answeredAt: string | null;
}

// ── Derived type aliases ──────────────────────────────────────────────────

/** Extracted from `ChatQuestion.status` so callers don't repeat the union. */
export type QuestionStatus = ChatQuestion["status"];

/** Role of a message in the right-pane chat. */
export type MessageRole = "user" | "assistant" | "system";

export interface ChatAttachment {
  readonly kind: "image" | "text";
  readonly name: string;
  readonly mimeType: string;
  /**
   * Images are base64-encoded bytes. Text attachments carry UTF-8 text.
   */
  readonly data: string;
}

export interface ChatAttachmentMetadata {
  readonly kind: "image" | "text";
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
}

// ── Attachment limits + helpers ────────────────────────────────────────────
//
// Canonical home for the attachment size math, formatting, and limit messages.
// Both the server (validation + 413s) and the web client (pre-send gate +
// toasts + size labels) import these so the two sides can never drift on the
// caps, the byte accounting, or the user-facing copy.

/** Per-attachment hard cap. */
export const MAX_CHAT_ATTACHMENT_BYTES = 5 * 1024 * 1024;
/** Combined cap across every attachment in a single message. */
export const MAX_CHAT_ATTACHMENTS_TOTAL_BYTES = 12 * 1024 * 1024;
/**
 * Hard cap on the number of attachments in a single message. Bounds the array
 * at the schema layer so a request can't carry an unbounded list of
 * just-under-cap fields before `validateAttachments` runs.
 */
export const MAX_CHAT_ATTACHMENTS_COUNT = 20;

// Reused across every `attachmentByteSize` call (hot on both the optimistic
// composer path and server-side validation) instead of allocating per call.
const TEXT_ENCODER = new TextEncoder();

/**
 * Decoded byte size of an attachment's payload. Images carry base64 (the
 * decoded byte count is ≈ 3/4 of the string length); text carries raw UTF-8.
 */
export function attachmentByteSize(attachment: ChatAttachment): number {
  if (attachment.kind === "image") {
    return Math.ceil((attachment.data.length * 3) / 4);
  }
  return TEXT_ENCODER.encode(attachment.data).byteLength;
}

/** Human-readable size label (B / KB / MB). */
export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Per-attachment over-limit message. */
export function attachmentTooLargeMessage(name: string): string {
  return `${name} is too large. Attachments are limited to ${
    MAX_CHAT_ATTACHMENT_BYTES / (1024 * 1024)
  } MB each.`;
}

/** Total-over-limit message. */
export function attachmentsTotalTooLargeMessage(): string {
  return `Attachments are too large. The total attachment limit is ${
    MAX_CHAT_ATTACHMENTS_TOTAL_BYTES / (1024 * 1024)
  } MB.`;
}

export interface ChatSessionCommand {
  readonly name: string;
  readonly description: string;
}

export interface ChatSessionContext {
  readonly commands: ReadonlyArray<ChatSessionCommand>;
  readonly promptImage: boolean;
  readonly embeddedContext: boolean;
  readonly repoFiles: ReadonlyArray<string>;
}

// ── SSE wire frame ────────────────────────────────────────────────────────

import type { Activity } from "./activity";

/**
 * The SSE frame discriminated union streamed from the server to the web
 * client during a chat turn. The activity variant carries the full
 * `Activity` shape inline so a frame stays a single flat JSON object on the
 * wire (the SSE parser doesn't have to walk a nested `data:` field).
 *
 * This is the *wire-level* contract between server and client — both import
 * from here. The server-internal `RawChatStreamFrame` (driver-emitted, pre-
 * persistence) lives in `apps/server/src/ai/providers/chat-types.ts`.
 */
export type ChatStreamFrame =
  | { readonly kind: "text"; readonly data: string }
  | { readonly kind: "reasoning"; readonly data: string }
  | ({ readonly kind: "activity" } & Activity)
  | {
      /**
       * Terminal output of a previously-streamed `activity`, correlated by
       * `callId`. Arrives after the activity frame (once the tool finishes)
       * so the web store patches the matching activity in place to power the
       * clickable output peek. Best-effort: may never arrive if the agent
       * doesn't report a terminal tool-call status.
       */
      readonly kind: "activity-result";
      readonly callId: string;
      readonly output: string;
      readonly isError: boolean;
    }
  | {
      /**
       * Late-arriving tool input for a previously-streamed `activity`,
       * correlated by `callId`. Some agents send the initial tool-call with an
       * empty `rawInput` and only populate it (the touched file, the command)
       * on a follow-up update — this frame patches the activity's payload in
       * place so its filename/command and file peek resolve.
       */
      readonly kind: "activity-input";
      readonly callId: string;
      readonly payload: unknown;
    }
  | {
      readonly kind: "task-list";
      readonly turnId: string;
      readonly tasks: ReadonlyArray<ChatTask>;
    }
  | {
      readonly kind: "plan-presented";
      readonly planId: string;
      readonly turnId: string;
      readonly markdown: string;
      readonly status: "pending";
    }
  | {
      readonly kind: "subagent-start";
      readonly invocationId: string;
      readonly parentTurnId: string;
      readonly subagentType: string;
      readonly description: string;
    }
  | {
      readonly kind: "subagent-end";
      readonly invocationId: string;
      readonly result: string;
      readonly ok: boolean;
    }
  | {
      readonly kind: "user-question";
      readonly questionId: string;
      readonly turnId: string;
      readonly questions: ReadonlyArray<NormalizedQuestion>;
      readonly previewFormat: "markdown" | "html";
      readonly status: "pending";
    }
  | {
      readonly kind: "user-question-resolved";
      readonly questionId: string;
      readonly status: "answered" | "rejected";
      readonly answers?: Readonly<Record<string, ReadonlyArray<string>>>;
      readonly customAnswers?: Readonly<Record<string, string>>;
    };
