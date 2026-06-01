// ── MCP route shared utilities ───────────────────────────────────────────────
//
// Types and helpers shared by all HTTP MCP transports (walkthrough, chat-context,
// etc.). Each transport is a thin JSON-RPC router; this module keeps the
// protocol boilerplate in one place.

import { Elysia } from "elysia";
import type { McpToolResult, ToolSpec, ToolSpecBundle } from "../../ai/providers/mcp-tool-gateway";
import { debug, logError } from "../../logger";

// ── JSON-RPC 2.0 types ───────────────────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: number | string | null;
  result: unknown;
}

export interface JsonRpcError {
  jsonrpc: "2.0";
  id: number | string | null;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

// ── Helpers ──────────────────────────────────────────────────────────────────

export function jsonRpcSuccess(id: number | string | null, result: unknown): JsonRpcSuccess {
  return { jsonrpc: "2.0", id, result };
}

export function jsonRpcError(
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

export function extractBearer(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (!auth) return null;
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  return match?.[1] ? match[1].trim() : null;
}

/**
 * Convert a zod object schema to an MCP-ish JSON Schema object. Uses the
 * standard `.toJSONSchema()` method when available, falling back to a
 * permissive schema so the tool is still callable (the zod schema still
 * validates on handler entry).
 */
export function toJsonSchema(schema: unknown): Record<string, unknown> {
  try {
    if (
      schema != null &&
      typeof schema === "object" &&
      "toJSONSchema" in schema &&
      typeof (schema as { toJSONSchema: unknown }).toJSONSchema === "function"
    ) {
      return (schema as { toJSONSchema: () => Record<string, unknown> }).toJSONSchema();
    }
  } catch {
    /* fall through — zod schema still validates on handler entry */
  }
  return { type: "object", properties: {}, additionalProperties: true };
}

// ── Shared HTTP binder ──────────────────────────────────────────────────────

export type ContextResolution<Ctx, Meta> =
  | { ok: true; ctx: Ctx; meta: Meta }
  | { ok: false; status: number; message: string };

export interface HttpToolCall<Ctx, Meta> {
  readonly toolName: string;
  readonly ctx: Ctx;
  readonly meta: Meta;
}

export interface BindHttpOptions<Ctx, Meta, Result extends McpToolResult> {
  readonly prefix?: string;
  readonly path: string;
  readonly logScope: string;
  readonly bundle: ToolSpecBundle<Ctx, Result>;
  readonly resolveContext: (req: Request) => Promise<ContextResolution<Ctx, Meta>>;
  readonly serverVersion?: string;
  readonly logInbound?: boolean;
  readonly specsForList?: (
    specs: ReadonlyArray<ToolSpec<Ctx, Result>>,
    meta: Meta,
  ) => ReadonlyArray<ToolSpec<Ctx, Result>>;
  readonly rejectToolCall?: (toolName: string, meta: Meta) => string | null;
  readonly beforeToolCall?: (call: HttpToolCall<Ctx, Meta>) => void;
  readonly servedMessage?: (requests: readonly JsonRpcRequest[], ctx: Ctx, meta: Meta) => string;
}

function normalizeRequests(body: unknown): JsonRpcRequest[] {
  return Array.isArray(body) ? (body as JsonRpcRequest[]) : [body as JsonRpcRequest];
}

function inboundMethod(body: unknown): string {
  if (body === null || body === undefined || typeof body !== "object") return "(unparseable)";
  if (Array.isArray(body)) {
    return `batch[${body.length}]: ${(body as Array<{ method?: string }>).map((r) => r?.method ?? "?").join(", ")}`;
  }
  return (body as { method?: string }).method ?? "(no method)";
}

function handleInitialize<Ctx, Result extends McpToolResult>(
  id: number | string | null,
  bundle: ToolSpecBundle<Ctx, Result>,
  serverVersion?: string,
): JsonRpcResponse {
  return jsonRpcSuccess(id, {
    protocolVersion: "2024-11-05",
    capabilities: { tools: {} },
    serverInfo: { name: bundle.name, version: serverVersion ?? bundle.version },
  });
}

function handleToolsList<Ctx, Result extends McpToolResult>(
  id: number | string | null,
  specs: ReadonlyArray<ToolSpec<Ctx, Result>>,
): JsonRpcResponse {
  const tools = specs.map((spec) => ({
    name: spec.name,
    description: spec.description,
    inputSchema: toJsonSchema(spec.inputSchema),
  }));
  return jsonRpcSuccess(id, { tools });
}

async function handleToolsCall<Ctx, Meta, Result extends McpToolResult>(
  id: number | string | null,
  params: unknown,
  resolved: { ctx: Ctx; meta: Meta },
  options: BindHttpOptions<Ctx, Meta, Result>,
): Promise<JsonRpcResponse> {
  if (params === null || typeof params !== "object") {
    return jsonRpcError(id, -32602, "tools/call: params must be an object");
  }
  const p = params as Record<string, unknown>;
  const name = typeof p.name === "string" ? p.name : null;
  if (!name) {
    return jsonRpcError(id, -32602, "tools/call: missing tool name");
  }

  const rejection = options.rejectToolCall?.(name, resolved.meta) ?? null;
  if (rejection) {
    return jsonRpcError(id, -32601, rejection);
  }

  const spec = options.bundle.specs.find((s) => s.name === name);
  if (!spec) {
    return jsonRpcError(id, -32601, `tools/call: unknown tool '${name}'`);
  }

  const parsed = spec.inputSchema.safeParse(p.arguments ?? {});
  if (!parsed.success) {
    return jsonRpcError(
      id,
      -32602,
      `tools/call: invalid arguments for '${name}': ${parsed.error.message}`,
    );
  }

  try {
    options.beforeToolCall?.({ toolName: name, ctx: resolved.ctx, meta: resolved.meta });
    const result = await spec.handler(resolved.ctx, parsed.data);
    return jsonRpcSuccess(id, result);
  } catch (err) {
    logError(
      options.logScope,
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
}

export function bindHttp<Ctx, Meta, Result extends McpToolResult>(
  options: BindHttpOptions<Ctx, Meta, Result>,
) {
  return new Elysia({ prefix: options.prefix ?? "/mcp" }).post(options.path, async (ctx) => {
    const req = ctx.request;
    const body: unknown = ctx.body;

    if (options.logInbound) {
      debug(options.logScope, `MCP request received: method=${inboundMethod(body)}`);
    }

    if (body === null || body === undefined || typeof body !== "object") {
      return new Response(
        JSON.stringify(jsonRpcError(null, -32700, "Parse error: body is not valid JSON")),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    const requests = normalizeRequests(body);
    if (requests.length === 0) {
      return new Response(JSON.stringify(jsonRpcError(null, -32600, "Empty request batch")), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const resolved = await options.resolveContext(req);
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
          responses.push(handleInitialize(rpcId, options.bundle, options.serverVersion));
        } else if (rpc.method === "notifications/initialized") {
          if (rpc.id !== undefined && rpc.id !== null) {
            responses.push(jsonRpcSuccess(rpcId, null));
          }
        } else if (rpc.method === "tools/list") {
          const specs =
            options.specsForList?.(options.bundle.specs, resolved.meta) ?? options.bundle.specs;
          responses.push(handleToolsList(rpcId, specs));
        } else if (rpc.method === "tools/call") {
          responses.push(await handleToolsCall(rpcId, rpc.params, resolved, options));
        } else {
          responses.push(jsonRpcError(rpcId, -32601, `Unknown method '${rpc.method}'`));
        }
      } catch (err) {
        logError(
          options.logScope,
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

    const served = options.servedMessage?.(requests, resolved.ctx, resolved.meta);
    if (served) {
      debug(options.logScope, served);
    }

    const payload = Array.isArray(body) ? responses : responses[0];
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
}
