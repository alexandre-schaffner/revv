// The persistence shape in `chat_tasks` and `chat_plans` mirrors these wire
// types 1:1.

/**
 * Session-level: `plan` keeps every turn in plan mode until the user toggles
 * back to `default` or approves a plan.
 */
export type InteractionMode = "default" | "plan";

/** How many prompts the chat's empty state offers for a PR. */
export const CHAT_SUGGESTION_COUNT = 3;

/** The empty state's prompts before a PR's own arrive, and whenever generating them fails. */
export const CHAT_SUGGESTION_FALLBACKS: readonly string[] = [
  "What's the riskiest change here?",
  "Summarize the security implications",
  "Suggest a test plan",
];

/**
 * One row of the agent's todo list (ACP `plan` update). Agents send the full
 * list on every update; the server upserts in place keyed on `taskId`.
 */
export interface ChatTask {
  readonly id: string;
  readonly content: string;
  readonly activeForm: string | null;
  readonly status: "pending" | "in_progress" | "completed";
  readonly priority: "low" | "medium" | "high" | null;
}

export interface ChatAttachment {
  readonly kind: "image" | "text";
  readonly name: string;
  readonly mimeType: string;
  /** Images are base64-encoded bytes; text attachments carry UTF-8 text. */
  readonly data: string;
}

export interface ChatAttachmentMetadata {
  readonly kind: "image" | "text";
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
}

export const MAX_CHAT_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_CHAT_ATTACHMENTS_TOTAL_BYTES = 12 * 1024 * 1024;
/**
 * Hard cap on the number of attachments in a single message. Bounds the array
 * at the schema layer so a request can't carry an unbounded list of
 * just-under-cap fields before `validateAttachments` runs.
 */
export const MAX_CHAT_ATTACHMENTS_COUNT = 20;

const TEXT_ENCODER = new TextEncoder();

/** Decoded payload size; for base64 images that is ≈ 3/4 of the string length. */
export function attachmentByteSize(attachment: ChatAttachment): number {
  if (attachment.kind === "image") {
    return Math.ceil((attachment.data.length * 3) / 4);
  }
  return TEXT_ENCODER.encode(attachment.data).byteLength;
}

export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function attachmentTooLargeMessage(name: string): string {
  return `${name} is too large. Attachments are limited to ${
    MAX_CHAT_ATTACHMENT_BYTES / (1024 * 1024)
  } MB each.`;
}

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

import type { Activity } from "./activity";
import type { ResolveFrame } from "./base-conflicts";

/**
 * Streamed during a chat turn. Each frame is one flat JSON object on the
 * wire: the activity variant spreads `Activity` inline.
 */
export type ChatStreamFrame =
  | { readonly kind: "text"; readonly data: string }
  | { readonly kind: "reasoning"; readonly data: string }
  | ({ readonly kind: "activity" } & Activity)
  | {
      /**
       * Terminal output of a previously-streamed `activity`, correlated by
       * `callId`. Best-effort: never arrives if the agent doesn't report a
       * terminal tool-call status.
       */
      readonly kind: "activity-result";
      readonly callId: string;
      readonly output: string;
      readonly isError: boolean;
    }
  | {
      /**
       * Late tool input for a previously-streamed `activity`, correlated by
       * `callId`: some agents send the tool call with an empty `rawInput` and
       * only fill it in on a follow-up update.
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
    };

/** A commit the chat agent made on its working branch that isn't on the PR yet. */
export interface ProposedCommit {
  readonly sha: string;
  readonly shortSha: string;
  readonly subject: string;
  readonly committedAt: string;
  readonly files: readonly string[];
}

/** Frames streamed by `POST /api/chat/:prId/proposed-changes/resolve-and-push`. */
export type ResolvePushFrame = ResolveFrame<{
  readonly pushedCommits: number;
  readonly branch: string;
}>;
