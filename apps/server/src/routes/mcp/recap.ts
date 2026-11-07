import { Effect } from "effect";
import { buildRecapActivity } from "../../ai/providers/recap-activity";
import type { RecapToolContext } from "../../ai/providers/recap-tools";
import { RECAP_TOOL_BUNDLE } from "../../ai/providers/recap-tools";
import { ProjectRecapJobs } from "../../services/ProjectRecapJobs";
import { bindTokenMcpRoute } from "./utils";

export const mcpRecapRoute = bindTokenMcpRoute({
  path: "/recap",
  logScope: "mcp-recap-route",
  bundle: RECAP_TOOL_BUNDLE,
  resolveToken: (token) =>
    Effect.flatMap(ProjectRecapJobs, (jobs) => jobs.resolveSessionToken(token)),
  rejected: "Session token not recognized, expired, or job no longer running",
  toContext: (ctx: RecapToolContext) => ({ ctx, meta: { recapId: ctx.recapId } }),
  logInbound: true,
  trace: { attribute: "recapId", key: (meta) => meta.recapId },
  // The agent's stream names an MCP tool call only by a human title; this is
  // the one place that knows which recap tool ran.
  beforeToolCall: ({ toolName, input, ctx }) => {
    ctx.onToolCall(toolName);
    ctx.emit({ type: "activity", data: buildRecapActivity(toolName, input) });
  },
  servedMessage: (requests, _ctx, meta) =>
    `served ${requests.length} request(s), recapId=${meta.recapId}`,
});
