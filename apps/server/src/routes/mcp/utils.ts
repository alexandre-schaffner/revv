// ── MCP route shared utilities ───────────────────────────────────────────────
//
// Types and helpers shared by all HTTP MCP transports (walkthrough, chat-context,
// etc.). Each transport is a thin JSON-RPC router; this module keeps the
// protocol boilerplate in one place.

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
