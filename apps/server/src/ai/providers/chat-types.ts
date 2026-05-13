// ── chat-types ──────────────────────────────────────────────────────────────
//
// SSE wire shape for the right-pane chat stream. Owns:
//   - `ChatStreamFrame` — the flat-discriminator union forwarded over SSE
//     between provider and route, and parsed by the web client.
//
// The structured tool-use shape (`Activity`, `ActivityKind`) and the
// classifier / tool-name normalizer live in `@revv/shared/activity` so
// walkthrough and chat both consume one source of truth (doctrine
// invariant #13: agent-path parity). This file re-exports them for callers
// that already import from `./chat-types` so the import sites don't churn.

import type { Activity, ActivityKind, ChatTask } from "@revv/shared";

export type { Activity, ActivityKind };
export { classifyTool, normalizeToolName } from "@revv/shared";

/**
 * The SSE frame discriminated union. The activity variant carries the full
 * `Activity` shape inline so a frame stays a single flat JSON object on the
 * wire (the SSE parser doesn't have to walk a nested `data:` field). The
 * walkthrough event surface uses the nested `{ type, data: Activity }` shape
 * to match its existing `WalkthroughStreamEvent` convention.
 *
 * Extended for plans / tasks / sub-agents:
 *   - `task-list` — full snapshot, sent on every TodoWrite / todo.updated.
 *   - `plan-presented` — a plan was emitted, server-assigned `planId`.
 *   - `subagent-start` / `subagent-end` — sub-agent invocation lifecycle.
 *
 * The activity frame's `subagentInvocationId` lives on the `Activity` shape
 * (set by the driver when the tool call belongs to a sub-agent's nested run).
 */
export type ChatStreamFrame =
	| { readonly kind: "text"; readonly data: string }
	| { readonly kind: "reasoning"; readonly data: string }
	| ({ readonly kind: "activity" } & Activity)
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
	  };

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
	  };
