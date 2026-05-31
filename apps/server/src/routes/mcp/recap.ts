// ── /mcp/recap ──────────────────────────────────────────────────────────────
//
// HTTP transport for the project-recap MCP tool surface. Token resolution and
// recap event emission are feature-specific; JSON-RPC dispatch is shared by
// the MCP tool gateway binder.

import type { RecapStreamEvent } from "@revv/shared";
import { Effect } from "effect";
import type { RecapToolContext } from "../../ai/providers/recap-tools";
import { RECAP_TOOL_BUNDLE } from "../../ai/providers/recap-tools";
import { logError } from "../../logger";
import { AppRuntime } from "../../runtime";
import { ProjectRecapJobs } from "../../services/ProjectRecapJobs";
import { bindHttp, type ContextResolution, extractBearer } from "./utils";

interface RecapRouteMeta {
  readonly recapId: string;
}

async function resolveContext(
  req: Request,
): Promise<ContextResolution<RecapToolContext, RecapRouteMeta>> {
  const token = extractBearer(req);
  if (!token) {
    return { ok: false, status: 401, message: "Missing bearer token" };
  }
  const baseCtx = await AppRuntime.runPromise(
    Effect.flatMap(ProjectRecapJobs, (jobs) => jobs.resolveSessionToken(token)),
  );
  if (!baseCtx) {
    return {
      ok: false,
      status: 403,
      message: "Session token not recognized, expired, or job no longer running",
    };
  }

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

  return {
    ok: true,
    ctx: { ...baseCtx, emit },
    meta: { recapId: baseCtx.recapId },
  };
}

export const mcpRecapRoute = bindHttp({
  path: "/recap",
  logScope: "mcp-recap-route",
  bundle: RECAP_TOOL_BUNDLE,
  resolveContext,
  logInbound: true,
  beforeToolCall: ({ toolName, ctx }) => {
    ctx.toolCalls?.add(toolName);
  },
  servedMessage: (requests, _ctx, meta) =>
    `served ${requests.length} request(s), recapId=${meta.recapId}`,
});
