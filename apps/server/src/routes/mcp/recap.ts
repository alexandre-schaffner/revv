// ── /mcp/recap ──────────────────────────────────────────────────────────────
//
// HTTP transport for the project-recap MCP tool surface. Token resolution and
// recap event emission are feature-specific; JSON-RPC dispatch is shared by
// the MCP tool gateway binder.

import type { RecapStreamEvent } from "@revv/shared";
import { Effect } from "effect";
import { buildRecapActivity } from "../../ai/providers/recap-activity";
import type { RecapToolContext } from "../../ai/providers/recap-tools";
import { RECAP_TOOL_BUNDLE } from "../../ai/providers/recap-tools";
import { logError } from "../../logger";
import { AppRuntime } from "../../runtime";
import { ProjectRecapJobs } from "../../services/ProjectRecapJobs";
import { bindTokenMcpRoute } from "./utils";

interface RecapRouteMeta {
  readonly recapId: string;
}

function toContext(baseCtx: RecapToolContext): { ctx: RecapToolContext; meta: RecapRouteMeta } {
  const emit = (event: RecapStreamEvent): void => {
    try {
      AppRuntime.runSync(
        Effect.flatMap(ProjectRecapJobs, (jobs) => jobs.emitEvent(baseCtx.recapId, event)),
      );
    } catch (err) {
      logError(
        "mcp-recap-route",
        `emitEvent failed for ${baseCtx.recapId}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  };
  return { ctx: { ...baseCtx, emit }, meta: { recapId: baseCtx.recapId } };
}

export const mcpRecapRoute = bindTokenMcpRoute({
  path: "/recap",
  logScope: "mcp-recap-route",
  bundle: RECAP_TOOL_BUNDLE,
  resolveToken: (token) =>
    Effect.flatMap(ProjectRecapJobs, (jobs) => jobs.resolveSessionToken(token)),
  rejected: "Session token not recognized, expired, or job no longer running",
  toContext,
  logInbound: true,
  traceAnchorKey: (meta) => meta.recapId,
  // The agent's stream names an MCP tool call only by a human title; this is
  // the one place that knows which recap tool ran.
  beforeToolCall: ({ toolName, input, ctx }) => {
    ctx.onToolCall(toolName);
    ctx.emit({ type: "activity", data: buildRecapActivity(toolName, input) });
  },
  servedMessage: (requests, _ctx, meta) =>
    `served ${requests.length} request(s), recapId=${meta.recapId}`,
});
