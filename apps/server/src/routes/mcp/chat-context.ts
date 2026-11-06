// ── /mcp/chat-context ──────────────────────────────────────────────────────
//
// HTTP transport for the right-pane chat agent's MCP tools. Token resolution,
// plan-mode filtering, and edit broadcasts are chat-specific; JSON-RPC
// dispatch is shared by the MCP tool gateway binder.

import { Effect } from "effect";
import {
  type ChatWalkthroughEditContext,
  EDIT_TOOL_SPECS,
} from "../../ai/providers/chat-edit-tools";
import { CHAT_TOOL_BUNDLE } from "../../ai/providers/chat-mcp-tools";
import { AppRuntime } from "../../runtime";
import { ChatMcpTokens, type ChatTokenResolved } from "../../services/ChatMcpTokens";
import { DbService } from "../../services/Db";
import { fireAndForgetThreadEventBroadcast, fireAndForgetWalkthroughEdit } from "./publish";
import { bindHttp, type ContextResolution, extractBearer } from "./utils";

const EDIT_TOOL_NAMES = new Set(EDIT_TOOL_SPECS.map((s) => s.name));

async function resolveContext(
  req: Request,
): Promise<ContextResolution<ChatWalkthroughEditContext, ChatTokenResolved>> {
  const token = extractBearer(req);
  if (!token) {
    return { ok: false, status: 401, message: "Missing bearer token" };
  }
  const db = await AppRuntime.runPromise(Effect.flatMap(DbService, (s) => Effect.succeed(s.db)));
  const resolved = await AppRuntime.runPromise(
    Effect.flatMap(ChatMcpTokens, (t) => t.resolve(token)),
  );
  if (!resolved) {
    return {
      ok: false,
      status: 403,
      message: "Chat MCP token not recognized or already revoked",
    };
  }

  return {
    ok: true,
    ctx: {
      db,
      prId: resolved.prId,
      userId: resolved.userId,
      actor: "chat:acp",
      publishEdit: fireAndForgetWalkthroughEdit,
      broadcastThreadEvent: (msg) => fireAndForgetThreadEventBroadcast(resolved.prId, msg),
    },
    meta: resolved,
  };
}

export const mcpChatContextRoute = bindHttp({
  path: "/chat-context",
  logScope: "mcp-chat-context",
  bundle: CHAT_TOOL_BUNDLE,
  resolveContext,
  serverVersion: "2.0.0",
  specsForList: (specs, resolved) =>
    resolved.interactionMode === "plan"
      ? specs.filter((spec) => !EDIT_TOOL_NAMES.has(spec.name))
      : specs,
  rejectToolCall: (name, resolved) =>
    resolved.interactionMode === "plan" && EDIT_TOOL_NAMES.has(name)
      ? `tools/call: '${name}' is disabled in plan mode — exit plan mode to make edits.`
      : null,
  servedMessage: (requests, ctx, meta) =>
    `served ${requests.length} request(s), prId=${ctx.prId}, mode=${meta.interactionMode}`,
});
