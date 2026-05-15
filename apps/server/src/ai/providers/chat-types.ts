// ── chat-types ──────────────────────────────────────────────────────────────
//
// SSE wire shape for the right-pane chat stream. Owns:
//   - `RawChatStreamFrame` — the internal driver-emitted union that the
//     route's persistence wrapper translates into the wire `ChatStreamFrame`.
//
// The wire `ChatStreamFrame` (shared between server and client) lives in
// `@revv/shared/chat` and is re-exported below for callers that already
// import from `./chat-types`.
//
// The structured tool-use shape (`Activity`, `ActivityKind`) and the
// classifier / tool-name normalizer live in `@revv/shared/activity` so
// walkthrough and chat both consume one source of truth (doctrine
// invariant #13: agent-path parity). This file re-exports them for callers
// that already import from `./chat-types` so the import sites don't churn.

import type { Activity, ActivityKind, ChatTask, NormalizedQuestion } from "@revv/shared";

// Re-export the canonical wire frame from shared.
export type { ChatStreamFrame } from "@revv/shared";
export { classifyTool, normalizeToolName } from "@revv/shared";
export type { Activity, ActivityKind, NormalizedQuestion };

/**
 * Internal driver-side frame. Drivers emit these with provider-keyed ids
 * (Claude `tool_use.id`, opencode `part.id`). The route's persistence wrapper
 * translates them into the wire `ChatStreamFrame` shape with server-assigned
 * ids (`planId`, `invocationId`).
 *
 * `subagentProviderCallId` on activities is the same provider-keyed id the
 * wrapper uses to look up the invocation it should stamp the activity with.
 */
export type RawChatStreamFrame =
  | { readonly kind: "text"; readonly data: string }
  | { readonly kind: "reasoning"; readonly data: string }
  | ({
      readonly kind: "activity";
      readonly subagentProviderCallId?: string;
    } & Activity)
  | {
      readonly kind: "task-list";
      readonly source: "claude" | "opencode";
      readonly tasks: ReadonlyArray<ChatTask>;
    }
  | {
      readonly kind: "plan-presented";
      readonly providerPlanId: string;
      readonly markdown: string;
      readonly source: "claude" | "opencode";
    }
  | {
      readonly kind: "subagent-start";
      readonly providerCallId: string;
      readonly subagentType: string;
      readonly description: string;
      readonly prompt: string;
      readonly source: "claude" | "opencode";
    }
  | {
      readonly kind: "subagent-end";
      readonly providerCallId: string;
      readonly result: string;
      readonly ok: boolean;
      readonly source: "claude" | "opencode";
    }
  | {
      readonly kind: "user-question";
      readonly providerRequestId: string;
      readonly questions: ReadonlyArray<NormalizedQuestion>;
      readonly previewFormat: "markdown" | "html";
      readonly source: "claude" | "opencode";
      readonly providerToolCallId?: string;
    }
  | {
      readonly kind: "user-question-resolved";
      readonly providerRequestId: string;
      readonly source: "opencode";
      readonly status: "answered" | "rejected";
      readonly answers?: Readonly<Record<string, ReadonlyArray<string>>>;
    };
