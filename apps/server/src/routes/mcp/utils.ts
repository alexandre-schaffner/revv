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

export function jsonRpcSuccess(
	id: number | string | null,
	result: unknown,
): JsonRpcSuccess {
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
	return match && match[1] ? match[1].trim() : null;
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
export function toJsonSchema(schema: any): Record<string, unknown> {
	try {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		if (schema && typeof (schema as any).toJSONSchema === "function") {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			return (schema as any).toJSONSchema() as Record<string, unknown>;
		}
	} catch {
		/* fall through */
	}
	return { type: "object", properties: {}, additionalProperties: true };
}
