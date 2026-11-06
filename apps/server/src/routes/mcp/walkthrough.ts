// ── /mcp/walkthrough ────────────────────────────────────────────────────────
//
// HTTP transport for the walkthrough MCP tool surface: the bearer token
// resolves to the run, whose context WalkthroughJobs built at launch; JSON-RPC
// dispatch is shared by the MCP tool gateway binder.

import { Effect } from "effect";
import { WALKTHROUGH_TOOL_BUNDLE } from "../../ai/providers/walkthrough-tools";
import { WalkthroughJobs } from "../../services/WalkthroughJobs";
import { bindTokenMcpRoute } from "./utils";

// ── MCP phase-tool exploration event map ─────────────────────────────────────

interface PhaseToolMeta {
  readonly activityKind: "tool.mcp";
  readonly summary: string;
}

const PHASE_TOOL_META: Record<string, PhaseToolMeta> = {
  set_overview: {
    activityKind: "tool.mcp",
    summary: "Writing overview and risk assessment...",
  },
  add_diff_step: {
    activityKind: "tool.mcp",
    summary: "Writing walkthrough step...",
  },
  add_semantic_step: {
    activityKind: "tool.mcp",
    summary: "Writing walkthrough step...",
  },
  flag_issue: {
    activityKind: "tool.mcp",
    summary: "Flagging a concern...",
  },
  rate_axis: {
    activityKind: "tool.mcp",
    summary: "Scoring PR quality...",
  },
  complete_walkthrough: {
    activityKind: "tool.mcp",
    summary: "Finalizing walkthrough...",
  },
  get_walkthrough_state: {
    activityKind: "tool.mcp",
    summary: "Reading walkthrough state...",
  },
};

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
    const phaseMeta = PHASE_TOOL_META[toolName];
    if (!phaseMeta) return;
    ctx.emit({
      type: "exploration",
      data: {
        activityKind: phaseMeta.activityKind,
        toolName,
        summary: phaseMeta.summary,
      },
    });
  },
  servedMessage: (requests, _ctx, meta) =>
    `served ${requests.length} request(s), walkthroughId=${meta.walkthroughId}`,
});
