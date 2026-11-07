import { Effect } from "effect";
import type { StackBriefToolContext } from "../../ai/providers/stack-brief-tools";
import { STACK_BRIEF_TOOL_BUNDLE } from "../../ai/providers/stack-brief-tools";
import { StackBriefJobs } from "../../services/stacks/StackBriefJobs";
import { bindTokenMcpRoute } from "./utils";

export const mcpStackBriefRoute = bindTokenMcpRoute({
  logScope: "mcp-stack-brief-route",
  bundle: STACK_BRIEF_TOOL_BUNDLE,
  resolveToken: (token) =>
    Effect.flatMap(StackBriefJobs, (jobs) => jobs.resolveSessionToken(token)),
  rejected: "Session token not recognized, expired, or job no longer running",
  toContext: (ctx: StackBriefToolContext) => ({ ctx, meta: { briefId: ctx.briefId } }),
  logInbound: true,
  trace: { attribute: "briefId", key: (meta) => meta.briefId },
  beforeToolCall: ({ spec, ctx }) => ctx.onToolCall(spec.name),
  servedMessage: (requests, _ctx, meta) =>
    `served ${requests.length} request(s), briefId=${meta.briefId}`,
});
