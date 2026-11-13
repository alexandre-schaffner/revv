import type { Activity, ChatTask } from "@revv/shared";

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
