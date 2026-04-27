// ── /mcp/walkthrough ────────────────────────────────────────────────────────
//
// HTTP transport for the walkthrough MCP tool surface. Mounted alongside the
// rest of the Elysia server. The opencode daemon registers this route as a
// remote MCP server; each of its tool calls hits POST /mcp/walkthrough with
// a Bearer token that WalkthroughJobs issued for the job.
//
// Per doctrine invariant #13 (agent-path parity), the handlers invoked here
// are the SAME handlers the Claude Agent SDK uses in-process
// (apps/server/src/ai/providers/walkthrough-tools.ts). This file is a thin
// JSON-RPC router that:
//   1. Authenticates the bearer token via WalkthroughJobs.resolveSessionToken.
//   2. Builds a WalkthroughToolContext with `emit` piped back through
//      WalkthroughJobs.emitEvent (so opencode-triggered tool calls surface
//      on the same in-process event bus the SSE subscribers listen on).
//   3. Dispatches `tools/list` / `tools/call` / `initialize` JSON-RPC methods
//      to the shared TOOL_SPECS array.
//
// We implement the JSON-RPC surface directly rather than pulling in the MCP
// SDK's Streamable HTTP transport — the surface we need is tiny (3 methods)
// and the SDK's transport is Express-focused, which doesn't compose cleanly
// with Elysia's handler model. Keep this route tight: a handful of methods,
// no persistence, no per-connection state.

import type { WalkthroughStreamEvent } from "@revv/shared";
import { Effect } from "effect";
import { Elysia } from "elysia";
import type {
  WalkthroughToolContext,
  WalkthroughToolResult,
} from "../../ai/providers/walkthrough-tool-spec";
import { TOOL_SPECS } from "../../ai/providers/walkthrough-tools";
import { debug, logError } from "../../logger";
import { AppRuntime } from "../../runtime";
import { DbService } from "../../services/Db";
import { WalkthroughJobs } from "../../services/WalkthroughJobs";

// ── JSON-RPC 2.0 types ───────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: unknown;
}

interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: number | string | null;
  result: unknown;
}

interface JsonRpcError {
  jsonrpc: "2.0";
  id: number | string | null;
  error: { code: number; message: string; data?: unknown };
}

type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

// ── Helpers ──────────────────────────────────────────────────────────────────

function jsonRpcSuccess(
  id: number | string | null,
  result: unknown,
): JsonRpcSuccess {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(
  id: number | string | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcError {
  return {
    jsonrpc: "2.0",
    id,
    error: data === undefined ? { code, message } : { code, message, data },
  };
}

function extractBearer(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (!auth) return null;
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  return match?.[1] ? match[1].trim() : null;
}

/**
 * Convert a zod object schema to an MCP-ish JSON Schema object. We use a
 * hand-rolled shape that opencode's MCP client will accept — the full JSON
 * Schema surface is not required for simple parameter introspection, but the
 * structural type + nested object/array support is. Fallback: if anything
 * fails, emit `{ type: "object", properties: {}, additionalProperties: true }`
 * so the tool is still callable (the zod schema still validates on handler
 * entry).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toJsonSchema(schema: any): Record<string, unknown> {
  try {
    // zod v4 exposes `.toJSONSchema()` / `z.toJSONSchema()`.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (schema && typeof (schema as any).toJSONSchema === "function") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (schema as any).toJSONSchema() as Record<string, unknown>;
    }
  } catch {
    /* fall through */
  }
  return {
    type: "object",
    properties: {},
    additionalProperties: true,
  };
}

// ── Token-scoped context builder ─────────────────────────────────────────────

async function resolveContext(
  req: Request,
): Promise<
  | { ok: true; ctx: WalkthroughToolContext }
  | { ok: false; status: number; message: string }
> {
  const token = extractBearer(req);
  if (!token) {
    return { ok: false, status: 401, message: "Missing bearer token" };
  }
  const db = await AppRuntime.runPromise(
    Effect.flatMap(DbService, (s) => Effect.succeed(s.db)),
  );
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
    void AppRuntime.runPromise(
      Effect.flatMap(WalkthroughJobs, (jobs) =>
        jobs.emitEvent(walkthroughId, event),
      ),
    ).catch((err) => {
      logError(
        "mcp-walkthrough-route",
        `emitEvent failed for ${walkthroughId}:`,
        err instanceof Error ? err.message : String(err),
      );
    });
  };
  return {
    ok: true,
    ctx: { db, walkthroughId, emit },
  };
}

// ── JSON-RPC method handlers ─────────────────────────────────────────────────

async function handleInitialize(
  id: number | string | null,
): Promise<JsonRpcResponse> {
  return jsonRpcSuccess(id, {
    protocolVersion: "2024-11-05",
    capabilities: {
      tools: {},
    },
    serverInfo: {
      name: "revv-walkthrough",
      version: "2.0.0",
    },
  });
}

async function handleToolsList(
  id: number | string | null,
): Promise<JsonRpcResponse> {
  const tools = TOOL_SPECS.map((spec) => ({
    name: spec.name,
    description: spec.description,
    inputSchema: toJsonSchema(spec.inputSchema),
  }));
  return jsonRpcSuccess(id, { tools });
}

async function handleToolsCall(
  id: number | string | null,
  params: unknown,
  ctx: WalkthroughToolContext,
): Promise<JsonRpcResponse> {
  if (params === null || typeof params !== "object") {
    return jsonRpcError(id, -32602, "tools/call: params must be an object");
  }
  const p = params as Record<string, unknown>;
  const name = typeof p.name === "string" ? p.name : null;
  if (!name) {
    return jsonRpcError(id, -32602, "tools/call: missing tool name");
  }
  const spec = TOOL_SPECS.find((s) => s.name === name);
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
  let result: WalkthroughToolResult;
  try {
    result = await spec.handler(ctx, parsed.data);
  } catch (err) {
    logError(
      "mcp-walkthrough-route",
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

export const mcpWalkthroughRoute = new Elysia({ prefix: "/mcp" }).post(
  "/walkthrough",
  async (ctx) => {
    const req = ctx.request;

    let body: unknown;
    try {
      body = (await req.json()) as unknown;
    } catch {
      return new Response(
        JSON.stringify(
          jsonRpcError(null, -32700, "Parse error: body is not valid JSON"),
        ),
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
      return new Response(
        JSON.stringify(jsonRpcError(null, -32600, "Empty request batch")),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    const resolved = await resolveContext(req);
    if (!resolved.ok) {
      return new Response(
        JSON.stringify(
          jsonRpcError(requests[0]?.id ?? null, -32000, resolved.message),
        ),
        {
          status: resolved.status,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    const responses: JsonRpcResponse[] = [];
    for (const rpc of requests) {
      if (!rpc || rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") {
        responses.push(
          jsonRpcError(rpc?.id ?? null, -32600, "Invalid JSON-RPC 2.0 request"),
        );
        continue;
      }
      const rpcId = rpc.id ?? null;
      try {
        if (rpc.method === "initialize") {
          responses.push(await handleInitialize(rpcId));
        } else if (rpc.method === "notifications/initialized") {
          // Notification — no response required. If an id was given we
          // still need to respond; otherwise we skip.
          if (rpc.id !== undefined && rpc.id !== null) {
            responses.push(jsonRpcSuccess(rpcId, null));
          }
        } else if (rpc.method === "tools/list") {
          responses.push(await handleToolsList(rpcId));
        } else if (rpc.method === "tools/call") {
          responses.push(
            await handleToolsCall(rpcId, rpc.params, resolved.ctx),
          );
        } else {
          responses.push(
            jsonRpcError(rpcId, -32601, `Unknown method '${rpc.method}'`),
          );
        }
      } catch (err) {
        logError(
          "mcp-walkthrough-route",
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
      "mcp-walkthrough-route",
      `served ${requests.length} request(s), walkthroughId=${resolved.ctx.walkthroughId}`,
    );

    const payload = Array.isArray(body) ? responses : responses[0];
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  },
);
