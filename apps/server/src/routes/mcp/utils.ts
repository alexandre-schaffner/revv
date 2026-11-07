import { spanName } from "@revv/shared/telemetry";
import { Effect } from "effect";
import { Elysia } from "elysia";
import type { McpToolResult, ToolSpec, ToolSpecBundle } from "../../ai/providers/mcp-tool-gateway";
import type { Db } from "../../db";
import { debug, logError } from "../../logger";
import { withGraftedSpan } from "../../observability/span-graft";
import { AppRuntime, type AppServices } from "../../runtime";
import { DbService } from "../../services/Db";

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

export type ContextResolution<Ctx, Meta> =
  | { ok: true; ctx: Ctx; meta: Meta }
  | { ok: false; status: number; message: string };

export type ConnectionResolution<Meta> =
  | { ok: true; meta: Meta }
  | { ok: false; status: number; message: string };

export interface HttpToolCall<Ctx, Meta, Result extends McpToolResult> {
  readonly spec: ToolSpec<Ctx, Result>;
  readonly input: Record<string, unknown>;
  readonly ctx: Ctx;
  readonly meta: Meta;
}

export interface BindHttpOptions<Ctx, Meta, Result extends McpToolResult> {
  readonly logScope: string;
  readonly bundle: ToolSpecBundle<Ctx, Result>;
  readonly resolveContext: (req: Request) => Promise<ContextResolution<Ctx, Meta>>;
  /**
   * Optional credential-only resolution for initialize/notifications/tools/list.
   * Tool calls still resolve the full project-bound context.
   */
  readonly resolveConnection?: (req: Request) => Promise<ConnectionResolution<Meta>>;
  readonly logInbound?: boolean;
  /** Why this caller may not use `spec`, or null. A refused tool is neither listed nor callable. */
  readonly refuse?: (spec: ToolSpec<Ctx, Result>, meta: Meta) => string | null;
  /**
   * The job that provoked this call: `key` is the id it published its trace
   * anchor under (see observability/span-graft.ts), stamped on the span as
   * `attribute`. Files each `tools/call` span inside that job's trace instead
   * of a trace of its own, which is what makes an agent's content writes
   * visible in the generation timeline. Omit for surfaces with no owning job
   * (chat context): the span is still recorded, just unparented.
   */
  readonly trace?: { readonly attribute: string; readonly key: (meta: Meta) => string };
  readonly beforeToolCall?: (call: HttpToolCall<Ctx, Meta, Result>) => void;
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
): JsonRpcResponse {
  return jsonRpcSuccess(id, {
    protocolVersion: "2024-11-05",
    capabilities: { tools: {} },
    serverInfo: { name: bundle.name, version: bundle.version },
  });
}

function handleToolsList<Ctx, Result extends McpToolResult>(
  id: number | string | null,
  specs: ReadonlyArray<ToolSpec<Ctx, Result>>,
): JsonRpcResponse {
  const tools = specs.map((spec) => ({
    name: spec.name,
    description: spec.description,
    // zod throws on what JSON Schema can't express (a `.transform()`); a
    // permissive fallback would silently strip the tool's contract.
    inputSchema: spec.inputSchema.toJSONSchema(),
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

  const spec = options.bundle.specs.find((s) => s.name === name);
  if (!spec) {
    return jsonRpcError(id, -32601, `tools/call: unknown tool '${name}'`);
  }
  const refusal = options.refuse?.(spec, resolved.meta) ?? null;
  if (refusal) {
    return jsonRpcError(id, -32601, refusal);
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
    options.beforeToolCall?.({
      spec,
      input: parsed.data,
      ctx: resolved.ctx,
      meta: resolved.meta,
    });
    const anchorKey = options.trace?.key(resolved.meta) ?? null;
    const result = await withGraftedSpan(
      anchorKey,
      spanName("mcp", name),
      {
        attributes: {
          mcp_tool: name,
          ...(anchorKey && options.trace ? { [options.trace.attribute]: anchorKey } : {}),
        },
      },
      () => spec.handler(resolved.ctx, parsed.data),
    );
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
  return new Elysia().post(options.bundle.route, async (ctx) => {
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

    let fullResolution: ContextResolution<Ctx, Meta> | null = null;
    let connectionResolution: ConnectionResolution<Meta> | null = null;

    if (options.resolveConnection) {
      // A pure tools/call request can go straight to full resolution. Mixed
      // batches authenticate once up front so handshake/list responses remain
      // independent from a checkout-resolution failure in a sibling call.
      if (requests.some((rpc) => rpc?.method !== "tools/call")) {
        connectionResolution = await options.resolveConnection(req);
      } else {
        fullResolution = await options.resolveContext(req);
        // A refused credential answers with its HTTP status here too, as on
        // the handshake: a bridge probing Revv's channels moves on to the next.
        if (
          !fullResolution.ok &&
          (fullResolution.status === 401 || fullResolution.status === 403)
        ) {
          connectionResolution = fullResolution;
        }
      }
    } else {
      fullResolution = await options.resolveContext(req);
      connectionResolution = fullResolution;
    }

    if (connectionResolution && !connectionResolution.ok) {
      return new Response(
        JSON.stringify(jsonRpcError(requests[0]?.id ?? null, -32000, connectionResolution.message)),
        {
          status: connectionResolution.status,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    const responses: JsonRpcResponse[] = [];
    for (const rpc of requests) {
      if (rpc?.jsonrpc !== "2.0" || typeof rpc.method !== "string") {
        responses.push(jsonRpcError(rpc?.id ?? null, -32600, "Invalid JSON-RPC 2.0 request"));
        continue;
      }
      const rpcId = rpc.id ?? null;
      try {
        if (rpc.method === "initialize") {
          responses.push(handleInitialize(rpcId, options.bundle));
        } else if (rpc.method === "notifications/initialized") {
          if (rpc.id !== undefined && rpc.id !== null) {
            responses.push(jsonRpcSuccess(rpcId, null));
          }
        } else if (rpc.method === "tools/list") {
          if (!connectionResolution?.ok) {
            responses.push(jsonRpcError(rpcId, -32603, "MCP connection was not resolved"));
            continue;
          }
          const { meta } = connectionResolution;
          const specs = options.refuse
            ? options.bundle.specs.filter((spec) => options.refuse?.(spec, meta) === null)
            : options.bundle.specs;
          responses.push(handleToolsList(rpcId, specs));
        } else if (rpc.method === "tools/call") {
          if (fullResolution === null) {
            fullResolution = await options.resolveContext(req);
          }
          if (!fullResolution?.ok) {
            responses.push(
              jsonRpcError(rpcId, -32000, fullResolution.message, {
                httpStatus: fullResolution.status,
              }),
            );
          } else {
            responses.push(await handleToolsCall(rpcId, rpc.params, fullResolution, options));
          }
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

    const served =
      fullResolution?.ok === true
        ? options.servedMessage?.(requests, fullResolution.ctx, fullResolution.meta)
        : null;
    if (served) {
      debug(options.logScope, served);
    }

    // Only notifications/responses (no `id`), e.g. the `notifications/initialized`
    // handshake step. The MCP Streamable HTTP spec wants 202 Accepted with an
    // empty body: strict clients (Codex's `rmcp`) JSON-parse a bodyless 200 and
    // fail with "EOF while parsing".
    if (responses.length === 0) {
      return new Response(null, { status: 202 });
    }

    const payload = Array.isArray(body) ? responses : responses[0];
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
}

export interface BindTokenRouteOptions<Ctx, Meta, Payload, Result extends McpToolResult>
  extends Omit<BindHttpOptions<Ctx, Meta, Result>, "resolveContext" | "resolveConnection"> {
  /** The bearer's payload from its issuer's token store; `null` when unknown, expired or revoked. */
  readonly resolveToken: (token: string) => Effect.Effect<Payload | null, never, AppServices>;
  /** The 403 message for a token that doesn't resolve. */
  readonly rejected: string;
  readonly toContext: (payload: Payload, db: Db) => { readonly ctx: Ctx; readonly meta: Meta };
}

/**
 * An MCP route whose caller is an agent Revv started, holding a per-run bearer
 * token: 401 without one, 403 when it doesn't resolve, otherwise the tool
 * context built from its payload.
 */
export function bindTokenMcpRoute<Ctx, Meta, Payload, Result extends McpToolResult>(
  options: BindTokenRouteOptions<Ctx, Meta, Payload, Result>,
) {
  const { resolveToken, rejected, toContext, ...rest } = options;
  return bindHttp<Ctx, Meta, Result>({
    ...rest,
    resolveContext: async (req) => {
      const token = extractBearer(req);
      if (!token) return { ok: false, status: 401, message: "Missing bearer token" };
      const resolved = await AppRuntime.runPromise(
        Effect.gen(function* () {
          const payload = yield* resolveToken(token);
          if (payload === null) return null;
          const { db } = yield* DbService;
          return { payload, db };
        }),
      );
      if (!resolved) return { ok: false, status: 403, message: rejected };
      return { ok: true, ...toContext(resolved.payload, resolved.db) };
    },
  });
}
