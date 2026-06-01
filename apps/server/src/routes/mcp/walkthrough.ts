// ── /mcp/walkthrough ────────────────────────────────────────────────────────
//
// HTTP transport for the walkthrough MCP tool surface. Authentication and
// context construction are walkthrough-specific; JSON-RPC dispatch is shared
// by the MCP tool gateway binder.

import type { ThreadEventMessage, WalkthroughStreamEvent } from "@revv/shared";
import { Effect } from "effect";
import type { WalkthroughToolContext } from "../../ai/providers/walkthrough-tools";
import { WALKTHROUGH_TOOL_BUNDLE } from "../../ai/providers/walkthrough-tools";
import { logError } from "../../logger";
import { AppRuntime } from "../../runtime";
import { fireAndForgetThreadEventBroadcast } from "../../services/broadcast-thread-event";
import { DbService } from "../../services/Db";
import { WalkthroughJobs } from "../../services/WalkthroughJobs";
import { bindHttp, type ContextResolution, extractBearer } from "./utils";

interface WalkthroughRouteMeta {
  readonly walkthroughId: string;
}

// ── Token-scoped context builder ─────────────────────────────────────────────

async function resolveContext(
  req: Request,
): Promise<ContextResolution<WalkthroughToolContext, WalkthroughRouteMeta>> {
  const token = extractBearer(req);
  if (!token) {
    return { ok: false, status: 401, message: "Missing bearer token" };
  }
  const db = await AppRuntime.runPromise(Effect.flatMap(DbService, (s) => Effect.succeed(s.db)));
  const resolved = await AppRuntime.runPromise(
    Effect.flatMap(WalkthroughJobs, (jobs) => jobs.resolveSessionToken(token)),
  );
  if (!resolved) {
    return {
      ok: false,
      status: 403,
      message: "Session token not recognized or job no longer running",
    };
  }

  const walkthroughId = resolved.walkthroughId;
  const emit = (event: WalkthroughStreamEvent): void => {
    try {
      AppRuntime.runSync(
        Effect.flatMap(WalkthroughJobs, (jobs) => jobs.emitEvent(walkthroughId, event)),
      );
    } catch (err) {
      logError(
        "mcp-walkthrough-route",
        `emitEvent failed for ${walkthroughId}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  };
  const broadcastThreadEvent = (msg: ThreadEventMessage): void => {
    fireAndForgetThreadEventBroadcast(
      "mcp-walkthrough-route",
      resolved.prId,
      "single-user",
      msg,
      resolved.accountId,
    );
  };

  return {
    ok: true,
    ctx: { db, walkthroughId, emit, broadcastThreadEvent },
    meta: { walkthroughId },
  };
}

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

export const mcpWalkthroughRoute = bindHttp({
  path: "/walkthrough",
  logScope: "mcp-walkthrough-route",
  bundle: WALKTHROUGH_TOOL_BUNDLE,
  resolveContext,
  logInbound: true,
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
