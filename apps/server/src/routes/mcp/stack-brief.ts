// ── /mcp/stack-brief ────────────────────────────────────────────────────────
//
// HTTP transport for the stack-brief MCP tools, mirroring `/mcp/recap`. Each
// bearer token is scoped to one brief; JSON-RPC dispatch is the shared
// gateway binder's.

import { Effect } from "effect";
import type { StackBriefToolContext } from "../../ai/providers/stack-brief-tools";
import { STACK_BRIEF_TOOL_BUNDLE } from "../../ai/providers/stack-brief-tools";
import { AppRuntime } from "../../runtime";
import { StackBriefJobs } from "../../services/stacks/StackBriefJobs";
import { bindHttp, type ContextResolution, extractBearer } from "./utils";

interface StackBriefRouteMeta {
  readonly briefId: string;
}

async function resolveContext(
  req: Request,
): Promise<ContextResolution<StackBriefToolContext, StackBriefRouteMeta>> {
  const token = extractBearer(req);
  if (!token) {
    return { ok: false, status: 401, message: "Missing bearer token" };
  }
  const ctx = await AppRuntime.runPromise(
    Effect.flatMap(StackBriefJobs, (jobs) => jobs.resolveSessionToken(token)),
  );
  if (!ctx) {
    return {
      ok: false,
      status: 403,
      message: "Session token not recognized, expired, or job no longer running",
    };
  }
  return { ok: true, ctx, meta: { briefId: ctx.briefId } };
}

export const mcpStackBriefRoute = bindHttp({
  path: "/stack-brief",
  logScope: "mcp-stack-brief-route",
  bundle: STACK_BRIEF_TOOL_BUNDLE,
  resolveContext,
  logInbound: true,
  beforeToolCall: ({ toolName, ctx }) => {
    ctx.toolCalls?.add(toolName);
  },
  servedMessage: (requests, _ctx, meta) =>
    `served ${requests.length} request(s), briefId=${meta.briefId}`,
});
