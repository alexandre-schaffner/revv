import { Effect } from "effect";
import { TOOL_SPECS, WALKTHROUGH_TOOL_BUNDLE } from "../../ai/providers/walkthrough-tools";
import { WalkthroughJobs } from "../../services/walkthrough/WalkthroughJobs";
import { bindTokenMcpRoute } from "./utils";

const TOOL_ACTIVITY = new Map(TOOL_SPECS.map((spec) => [spec.name, spec.activity]));

export const mcpWalkthroughRoute = bindTokenMcpRoute({
  path: "/walkthrough",
  logScope: "mcp-walkthrough-route",
  bundle: WALKTHROUGH_TOOL_BUNDLE,
  resolveToken: (token) =>
    Effect.flatMap(WalkthroughJobs, (jobs) => jobs.resolveSessionToken(token)),
  rejected: "Session token not recognized or job no longer running",
  toContext: (run) => ({ ctx: run.context.tools, meta: { walkthroughId: run.id } }),
  logInbound: true,
  // File each content write inside the generation's trace — the agent calls us
  // from its own subprocess, so without this every write is an orphan trace.
  traceAnchorKey: (meta) => meta.walkthroughId,
  beforeToolCall: ({ toolName, ctx }) => {
    const summary = TOOL_ACTIVITY.get(toolName);
    if (summary === undefined) return;
    ctx.emit({ type: "exploration", data: { activityKind: "tool.mcp", toolName, summary } });
  },
  servedMessage: (requests, _ctx, meta) =>
    `served ${requests.length} request(s), walkthroughId=${meta.walkthroughId}`,
});
