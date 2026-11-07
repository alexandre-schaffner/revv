import { Effect } from "effect";
import type { ChatWalkthroughEditContext } from "../../ai/providers/chat-edit-tools";
import { CHAT_TOOL_BUNDLE } from "../../ai/providers/chat-mcp-tools";
import type { Db } from "../../db";
import { ChatMcpTokens, type ChatTokenResolved } from "../../services/ChatMcpTokens";
import { fireAndForgetThreadEventBroadcast, fireAndForgetWalkthroughEdit } from "./publish";
import { bindTokenMcpRoute } from "./utils";

function toContext(
  resolved: ChatTokenResolved,
  db: Db,
): { ctx: ChatWalkthroughEditContext; meta: ChatTokenResolved } {
  return {
    ctx: {
      db,
      prId: resolved.prId,
      actor: "chat:acp",
      publishEdit: fireAndForgetWalkthroughEdit,
      broadcastThreadEvent: (msg) => fireAndForgetThreadEventBroadcast(resolved.prId, msg),
    },
    meta: resolved,
  };
}

export const mcpChatContextRoute = bindTokenMcpRoute({
  logScope: "mcp-chat-context",
  bundle: CHAT_TOOL_BUNDLE,
  resolveToken: (token) => Effect.flatMap(ChatMcpTokens, (tokens) => tokens.resolve(token)),
  rejected: "Chat MCP token not recognized, expired or already revoked",
  toContext,
  refuse: (spec, resolved) =>
    resolved.interactionMode === "plan" && spec.access === "write"
      ? `tools/call: '${spec.name}' is disabled in plan mode — exit plan mode to make edits.`
      : null,
  servedMessage: (requests, ctx, meta) =>
    `served ${requests.length} request(s), prId=${ctx.prId}, mode=${meta.interactionMode}`,
});
