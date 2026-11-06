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
// walkthrough and chat both consume one source of truth.

import type { Activity, ChatTask } from "@revv/shared";

// Re-export the canonical wire frame from shared.
export type { ChatStreamFrame } from "@revv/shared";

/**
 * Internal driver-side frame. The route's persistence wrapper translates it
 * into the wire `ChatStreamFrame`, assigning server ids (`planId`, `turnId`).
 */
export type RawChatStreamFrame =
  | { readonly kind: "text"; readonly data: string }
  | { readonly kind: "reasoning"; readonly data: string }
  | ({ readonly kind: "activity" } & Activity)
  | {
      readonly kind: "activity-result";
      readonly callId: string;
      readonly output: string;
      readonly isError: boolean;
    }
  | {
      readonly kind: "activity-input";
      readonly callId: string;
      readonly payload: unknown;
    }
  | {
      readonly kind: "task-list";
      readonly tasks: ReadonlyArray<ChatTask>;
    }
  | { readonly kind: "plan-presented"; readonly markdown: string };
