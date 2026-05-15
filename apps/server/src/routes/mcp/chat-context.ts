// ── /mcp/chat-context ──────────────────────────────────────────────────────
//
// HTTP transport for the right-pane chat agent's MCP tool surface. Covers
// both READ (`get_review_context`) and WRITE (walkthrough-edit tools, see
// CLAUDE.md invariant #7 chat-edit carve-out) tools, dispatching to the
// shared CHAT_TOOL_SPECS array.
//
// Authentication: bearer token issued by `ChatMcpTokens.issue({ prId,
// userId, actor, interactionMode })` from the chat-opencode.ts driver.
// Revoked when the chat turn finishes.
//
// Plan-mode filter: when the bound token's `interactionMode === 'plan'`,
// the edit-tool surface is hidden from `tools/list` and dispatch refuses
// edit calls. The agent can still inspect via `get_review_context` /
// `get_walkthrough_for_edit`.

import type { WalkthroughStreamEvent, WsServerMessage } from "@revv/shared";
import { Effect } from "effect";
import { Elysia } from "elysia";
import { EDIT_TOOL_SPECS } from "../../ai/providers/chat-edit-tools";
import {
  CHAT_TOOL_SPECS,
  type ChatToolContext,
  type ChatToolResult,
} from "../../ai/providers/chat-mcp-tools";
import { debug, logError } from "../../logger";
import { AppRuntime } from "../../runtime";
import { ChatMcpTokens, type ChatTokenResolved } from "../../services/ChatMcpTokens";
import { DbService } from "../../services/Db";
import { WebSocketHub } from "../../services/WebSocketHub";
import {
  extractBearer,
  type JsonRpcRequest,
  type JsonRpcResponse,
  jsonRpcError,
  jsonRpcSuccess,
  toJsonSchema,
} from "./utils";

// Edit-tool names — kept in a Set so plan-mode filtering and dispatch
// guards are O(1).
const EDIT_TOOL_NAMES = new Set(EDIT_TOOL_SPECS.map((s) => s.name));

// ── Token-scoped context builder ────────────────────────────────────────────

async function resolveContext(
  req: Request,
): Promise<
  | { ok: true; ctx: ChatToolContext; resolved: ChatTokenResolved }
  | { ok: false; status: number; message: string }
> {
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

  // emit: wraps a WalkthroughStreamEvent into the WS envelope and
  // broadcasts via WebSocketHub. Fire-and-forget — broadcast is
  // best-effort (doctrine invariant #8: commit first, broadcast second;
  // subscribers reconcile via DB re-read on reconnect).
  const emit = (walkthroughId: string, event: WalkthroughStreamEvent): void => {
    void AppRuntime.runPromise(
      Effect.flatMap(WebSocketHub, (hub) =>
        hub.broadcast({
          type: "walkthrough:edited",
          data: { prId: resolved.prId, walkthroughId, event },
        }),
      ),
    ).catch((err) => {
      logError(
        "mcp-chat-context",
        "walkthrough:edited broadcast failed:",
        err instanceof Error ? err.message : String(err),
      );
    });
  };

  const broadcastThreadEvent = (msg: WsServerMessage): void => {
    void AppRuntime.runPromise(Effect.flatMap(WebSocketHub, (hub) => hub.broadcast(msg))).catch(
      (err) => {
        logError(
          "mcp-chat-context",
          "thread event broadcast failed:",
          err instanceof Error ? err.message : String(err),
        );
      },
    );
  };

  return {
    ok: true,
    ctx: {
      db,
      prId: resolved.prId,
      userId: resolved.userId,
      actor: resolved.actor,
      emit,
      broadcastThreadEvent,
    },
    resolved,
  };
}

// ── JSON-RPC method handlers ────────────────────────────────────────────────

async function handleInitialize(id: number | string | null): Promise<JsonRpcResponse> {
  return jsonRpcSuccess(id, {
    protocolVersion: "2024-11-05",
    capabilities: { tools: {} },
    serverInfo: { name: "revv-chat-context", version: "2.0.0" },
  });
}

async function handleToolsList(
  id: number | string | null,
  resolved: ChatTokenResolved,
): Promise<JsonRpcResponse> {
  const filtered = CHAT_TOOL_SPECS.filter((spec) => {
    if (resolved.interactionMode === "plan" && EDIT_TOOL_NAMES.has(spec.name)) {
      return false;
    }
    return true;
  });
  const tools = filtered.map((spec) => ({
    name: spec.name,
    description: spec.description,
    inputSchema: toJsonSchema(spec.inputSchema),
  }));
  return jsonRpcSuccess(id, { tools });
}

async function handleToolsCall(
  id: number | string | null,
  params: unknown,
  ctx: ChatToolContext,
  resolved: ChatTokenResolved,
): Promise<JsonRpcResponse> {
  if (params === null || typeof params !== "object") {
    return jsonRpcError(id, -32602, "tools/call: params must be an object");
  }
  const p = params as Record<string, unknown>;
  const name = typeof p.name === "string" ? p.name : null;
  if (!name) {
    return jsonRpcError(id, -32602, "tools/call: missing tool name");
  }
  if (resolved.interactionMode === "plan" && EDIT_TOOL_NAMES.has(name)) {
    return jsonRpcError(
      id,
      -32601,
      `tools/call: '${name}' is disabled in plan mode — exit plan mode to make edits.`,
    );
  }
  const spec = CHAT_TOOL_SPECS.find((s) => s.name === name);
  if (!spec) {
    return jsonRpcError(id, -32601, `tools/call: unknown tool '${name}'`);
  }
  const rawArgs = p.arguments;
  const parsed = spec.inputSchema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return jsonRpcError(
      id,
      -32602,
      `tools/call: invalid arguments for '${name}': ${parsed.error.message}`,
    );
  }
  let result: ChatToolResult;
  try {
    result = await spec.handler(ctx, parsed.data);
  } catch (err) {
    logError(
      "mcp-chat-context",
      `handler '${name}' threw:`,
      err instanceof Error ? err.message : String(err),
    );
    return jsonRpcError(
      id,
      -32603,
      `tools/call: handler '${name}' threw`,
      err instanceof Error ? err.message : String(err),
    );
  }
  return jsonRpcSuccess(id, result);
}

// ── Elysia route ────────────────────────────────────────────────────────────

export const mcpChatContextRoute = new Elysia({ prefix: "/mcp" }).post(
  "/chat-context",
  async (ctx) => {
    const req = ctx.request;

    // Elysia pre-parses the request body (consuming the stream) before the
    // handler runs, so `req.json()` would fail with "Body already used".
    // Use `ctx.body` which holds the already-parsed value.
    const body: unknown = ctx.body;

    if (body === null || body === undefined || typeof body !== "object") {
      return new Response(
        JSON.stringify(jsonRpcError(null, -32700, "Parse error: body is not valid JSON")),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    const requests: JsonRpcRequest[] = Array.isArray(body)
      ? (body as JsonRpcRequest[])
      : [body as JsonRpcRequest];
    if (requests.length === 0) {
      return new Response(JSON.stringify(jsonRpcError(null, -32600, "Empty request batch")), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const resolved = await resolveContext(req);
    if (!resolved.ok) {
      return new Response(
        JSON.stringify(jsonRpcError(requests[0]?.id ?? null, -32000, resolved.message)),
        {
          status: resolved.status,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    const responses: JsonRpcResponse[] = [];
    for (const rpc of requests) {
      if (!rpc || rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") {
        responses.push(jsonRpcError(rpc?.id ?? null, -32600, "Invalid JSON-RPC 2.0 request"));
        continue;
      }
      const rpcId = rpc.id ?? null;
      try {
        if (rpc.method === "initialize") {
          responses.push(await handleInitialize(rpcId));
        } else if (rpc.method === "notifications/initialized") {
          if (rpc.id !== undefined && rpc.id !== null) {
            responses.push(jsonRpcSuccess(rpcId, null));
          }
        } else if (rpc.method === "tools/list") {
          responses.push(await handleToolsList(rpcId, resolved.resolved));
        } else if (rpc.method === "tools/call") {
          responses.push(await handleToolsCall(rpcId, rpc.params, resolved.ctx, resolved.resolved));
        } else {
          responses.push(jsonRpcError(rpcId, -32601, `Unknown method '${rpc.method}'`));
        }
      } catch (err) {
        logError(
          "mcp-chat-context",
          `dispatch error for method '${rpc.method}':`,
          err instanceof Error ? err.message : String(err),
        );
        responses.push(
          jsonRpcError(
            rpcId,
            -32603,
            "Internal error",
            err instanceof Error ? err.message : String(err),
          ),
        );
      }
    }

    debug(
      "mcp-chat-context",
      `served ${requests.length} request(s), prId=${resolved.ctx.prId}, mode=${resolved.resolved.interactionMode}`,
    );

    const payload = Array.isArray(body) ? responses : responses[0];
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  },
);
