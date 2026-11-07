import { SPAN_ATTR } from "@revv/shared/telemetry";
import { Effect } from "effect";
import { toolCallActivity } from "../../ai/providers/mcp-tool-gateway";
import { WALKTHROUGH_TOOL_BUNDLE } from "../../ai/providers/walkthrough-tools";
import { WalkthroughJobs } from "../../services/walkthrough/WalkthroughJobs";
import { bindTokenMcpRoute } from "./utils";

export const mcpWalkthroughRoute = bindTokenMcpRoute({
  logScope: "mcp-walkthrough-route",
  bundle: WALKTHROUGH_TOOL_BUNDLE,
  resolveToken: (token) =>
    Effect.flatMap(WalkthroughJobs, (jobs) => jobs.resolveSessionToken(token)),
  rejected: "Session token not recognized or job no longer running",
  toContext: (run) => ({ ctx: run.context.tools, meta: { walkthroughId: run.id } }),
  logInbound: true,
  // File each content write inside the generation's trace — the agent calls us
  // from its own subprocess, so without this every write is an orphan trace.
  trace: { attribute: SPAN_ATTR.walkthroughId, key: (meta) => meta.walkthroughId },
  beforeToolCall: ({ spec, input, ctx }) => {
    const activity = toolCallActivity(spec, input);
    if (activity) ctx.emit({ type: "exploration", data: activity });
  },
  servedMessage: (requests, _ctx, meta) =>
    `served ${requests.length} request(s), walkthroughId=${meta.walkthroughId}`,
});
