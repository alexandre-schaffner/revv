// ── /mcp/recap ──────────────────────────────────────────────────────────────
//
// HTTP transport for the project-recap MCP tool surface. Mounted alongside
// the rest of the Elysia server. The opencode daemon registers this route as
// a remote MCP server; each of its tool calls hits POST /mcp/recap with a
// Bearer token that `ProjectRecapJobs` issued for the running job.
//
// Per CLAUDE.md invariant #13 (agent-path parity), the handlers invoked here
// are the SAME handlers the Claude Agent SDK uses in-process — see
// `apps/server/src/ai/providers/recap-tools/`. This file is a thin JSON-RPC
// router that:
//   1. Authenticates the bearer token via ProjectRecapJobs.resolveSessionToken.
//   2. Reuses the per-job RecapToolContext stored under that token (recapId
//      + sourceBundle + priorRecaps + onCompleted hook) so the shared
//      handlers behave identically to the in-process path.
//   3. Dispatches `initialize` / `tools/list` / `tools/call` JSON-RPC
//      methods against `RECAP_TOOL_SPECS`.
//
// Recap is single-phase (no SSE, no exploration events, no phase machine),
// so this route is meaningfully simpler than `/mcp/walkthrough` — no `emit`
// callback, no `broadcastThreadEvent`. Status broadcasts happen at
// orchestrator completion only.

import type { RecapStreamEvent } from "@revv/shared";
import { Effect } from "effect";
import { Elysia } from "elysia";
import type { RecapToolContext, RecapToolResult } from "../../ai/providers/recap-tools";
import { RECAP_TOOL_SPECS } from "../../ai/providers/recap-tools";
import { debug, logError } from "../../logger";
import { AppRuntime } from "../../runtime";
import { ProjectRecapJobs } from "../../services/ProjectRecapJobs";
import {
  extractBearer,
  type JsonRpcRequest,
  type JsonRpcResponse,
  jsonRpcError,
  jsonRpcSuccess,
  toJsonSchema,
} from "./utils";

// ── Token-scoped context resolver ────────────────────────────────────────────

async function resolveContext(
  req: Request,
): Promise<{ ok: true; ctx: RecapToolContext } | { ok: false; status: number; message: string }> {
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

  // Sync emit path: tool handlers fire events synchronously so they don't
  // lag behind lifecycle events in the SSE subscriber buffer.
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

  const ctx: RecapToolContext = { ...baseCtx, emit };
  return { ok: true, ctx };
}

// ── JSON-RPC method handlers ─────────────────────────────────────────────────

async function handleInitialize(id: number | string | null): Promise<JsonRpcResponse> {
  return jsonRpcSuccess(id, {
    protocolVersion: "2024-11-05",
    capabilities: { tools: {} },
    serverInfo: { name: "revv-recap", version: "1.0.0" },
  });
}

async function handleToolsList(id: number | string | null): Promise<JsonRpcResponse> {
  const tools = RECAP_TOOL_SPECS.map((spec) => ({
    name: spec.name,
    description: spec.description,
    inputSchema: toJsonSchema(spec.inputSchema),
  }));
  return jsonRpcSuccess(id, { tools });
}

async function handleToolsCall(
  id: number | string | null,
  params: unknown,
  ctx: RecapToolContext,
): Promise<JsonRpcResponse> {
  if (params === null || typeof params !== "object") {
    return jsonRpcError(id, -32602, "tools/call: params must be an object");
  }
  const p = params as Record<string, unknown>;
  const name = typeof p.name === "string" ? p.name : null;
  if (!name) {
    return jsonRpcError(id, -32602, "tools/call: missing tool name");
  }
  const spec = RECAP_TOOL_SPECS.find((s) => s.name === name);
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

  let result: RecapToolResult;
  try {
    ctx.toolCalls?.add(name);
    result = await spec.handler(ctx, parsed.data);
  } catch (err) {
    logError(
      "mcp-recap-route",
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

// ── Elysia route ─────────────────────────────────────────────────────────────

export const mcpRecapRoute = new Elysia({ prefix: "/mcp" }).post("/recap", async (ctx) => {
  const req = ctx.request;

  // Elysia pre-parses the request body before the handler runs; reuse the
  // parsed value instead of calling `req.json()` (which would fail with
  // "Body already used"). Same pattern as the walkthrough route.
  const body: unknown = ctx.body;

  const inboundMethod = (() => {
    if (body === null || body === undefined || typeof body !== "object") return "(unparseable)";
    if (Array.isArray(body)) {
      return `batch[${body.length}]: ${(body as Array<{ method?: string }>).map((r) => r?.method ?? "?").join(", ")}`;
    }
    return (body as { method?: string }).method ?? "(no method)";
  })();
  debug("mcp-recap-route", `MCP request received: method=${inboundMethod}`);

  if (body === null || body === undefined || typeof body !== "object") {
    return new Response(
      JSON.stringify(jsonRpcError(null, -32700, "Parse error: body is not valid JSON")),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  // Accept batched JSON-RPC requests (array) as well as single requests.
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
        responses.push(await handleToolsList(rpcId));
      } else if (rpc.method === "tools/call") {
        responses.push(await handleToolsCall(rpcId, rpc.params, resolved.ctx));
      } else {
        responses.push(jsonRpcError(rpcId, -32601, `Unknown method '${rpc.method}'`));
      }
    } catch (err) {
      logError(
        "mcp-recap-route",
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

  debug("mcp-recap-route", `served ${requests.length} request(s), recapId=${resolved.ctx.recapId}`);

  const payload = Array.isArray(body) ? responses : responses[0];
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
