import { Effect } from "effect";
import {
  type ChatWalkthroughEditContext,
  EDIT_TOOL_SPECS,
} from "../../ai/providers/chat-edit-tools";
import { CHAT_TOOL_BUNDLE } from "../../ai/providers/chat-mcp-tools";
import type { Db } from "../../db";
import { ChatMcpTokens, type ChatTokenResolved } from "../../services/chat/ChatMcpTokens";
import { fireAndForgetThreadEventBroadcast, fireAndForgetWalkthroughEdit } from "./publish";
import { bindTokenMcpRoute } from "./utils";

const EDIT_TOOL_NAMES = new Set(EDIT_TOOL_SPECS.map((s) => s.name));

function toContext(
  resolved: ChatTokenResolved,
  db: Db,
): { ctx: ChatWalkthroughEditContext; meta: ChatTokenResolved } {
  return {
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

export const mcpChatContextRoute = bindTokenMcpRoute({
  path: "/chat-context",
  logScope: "mcp-chat-context",
  bundle: CHAT_TOOL_BUNDLE,
  resolveToken: (token) => Effect.flatMap(ChatMcpTokens, (tokens) => tokens.resolve(token)),
  rejected: "Chat MCP token not recognized, expired or already revoked",
  toContext,
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
