// ── /mcp/chat-context ──────────────────────────────────────────────────────
//
// HTTP transport for the right-pane chat agent's read-only context tools.
// Mirrors `/mcp/walkthrough` (see that file's header for the design
// rationale) but with a much smaller surface — read-only, no event bus, no
// per-job emit channel.
//
// Authentication: bearer token issued by `ChatMcpTokens.issue(prId)` from
// the chat-opencode.ts driver. Revoked when the chat turn finishes.

import { Elysia } from "elysia";
import { Effect } from "effect";
import { AppRuntime } from "../../runtime";
import { DbService } from "../../services/Db";
import { ChatMcpTokens } from "../../services/ChatMcpTokens";
import { debug, logError } from "../../logger";
import {
	CHAT_TOOL_SPECS,
	type ChatToolContext,
	type ChatToolResult,
} from "../../ai/providers/chat-mcp-tools";

// ── JSON-RPC 2.0 types ──────────────────────────────────────────────────────

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
	return match && match[1] ? match[1].trim() : null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toJsonSchema(schema: any): Record<string, unknown> {
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

// ── Token-scoped context builder ────────────────────────────────────────────

async function resolveContext(
	req: Request,
): Promise<
	| { ok: true; ctx: ChatToolContext }
	| { ok: false; status: number; message: string }
> {
	const token = extractBearer(req);
	if (!token) {
		return { ok: false, status: 401, message: "Missing bearer token" };
	}
	const db = await AppRuntime.runPromise(
		Effect.flatMap(DbService, (s) => Effect.succeed(s.db)),
	);
	const prId = await AppRuntime.runPromise(
		Effect.flatMap(ChatMcpTokens, (t) => t.resolve(token)),
	);
	if (!prId) {
		return {
			ok: false,
			status: 403,
			message: "Chat MCP token not recognized or already revoked",
		};
	}
	return { ok: true, ctx: { db, prId } };
}

// ── JSON-RPC method handlers ────────────────────────────────────────────────

async function handleInitialize(
	id: number | string | null,
): Promise<JsonRpcResponse> {
	return jsonRpcSuccess(id, {
		protocolVersion: "2024-11-05",
		capabilities: { tools: {} },
		serverInfo: { name: "revv-chat-context", version: "1.0.0" },
	});
}

async function handleToolsList(
	id: number | string | null,
): Promise<JsonRpcResponse> {
	const tools = CHAT_TOOL_SPECS.map((spec) => ({
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
): Promise<JsonRpcResponse> {
	if (params === null || typeof params !== "object") {
		return jsonRpcError(id, -32602, "tools/call: params must be an object");
	}
	const p = params as Record<string, unknown>;
	const name = typeof p["name"] === "string" ? p["name"] : null;
	if (!name) {
		return jsonRpcError(id, -32602, "tools/call: missing tool name");
	}
	const spec = CHAT_TOOL_SPECS.find((s) => s.name === name);
	if (!spec) {
		return jsonRpcError(id, -32601, `tools/call: unknown tool '${name}'`);
	}
	const rawArgs = p["arguments"];
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
					jsonRpcError(
						requests[0]?.id ?? null,
						-32000,
						resolved.message,
					),
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
					jsonRpcError(
						rpc?.id ?? null,
						-32600,
						"Invalid JSON-RPC 2.0 request",
					),
				);
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
			`served ${requests.length} request(s), prId=${resolved.ctx.prId}`,
		);

		const payload = Array.isArray(body) ? responses : responses[0];
		return new Response(JSON.stringify(payload), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	},
);
