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

import type { Activity, ActivityKind } from "@revv/shared";

export type { Activity, ActivityKind };
export { classifyTool, normalizeToolName } from "@revv/shared";

/**
 * The SSE frame discriminated union. The activity variant carries the full
 * `Activity` shape inline so a frame stays a single flat JSON object on the
 * wire (the SSE parser doesn't have to walk a nested `data:` field). The
 * walkthrough event surface uses the nested `{ type, data: Activity }` shape
 * to match its existing `WalkthroughStreamEvent` convention.
 */
export type ChatStreamFrame =
	| { readonly kind: "text"; readonly data: string }
	| ({ readonly kind: "activity" } & Activity);
