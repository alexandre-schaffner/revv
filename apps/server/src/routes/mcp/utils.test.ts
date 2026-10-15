import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { bindHttp } from "./utils";

function request(body: unknown): Request {
  return new Request("http://localhost/mcp/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("bindHttp connection resolution", () => {
  it("authenticates initialize and tools/list without resolving tool context", async () => {
    let connectionCalls = 0;
    let contextCalls = 0;
    const app = bindHttp({
      path: "/test",
      logScope: "mcp-test",
      bundle: {
        name: "test",
        version: "1",
        specs: [
          {
            name: "echo",
            description: "Echo",
            inputSchema: z.object({}),
            handler: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
          },
        ],
      },
      resolveConnection: async () => {
        connectionCalls += 1;
        return { ok: true, meta: { scopes: ["read"] } };
      },
      resolveContext: async () => {
        contextCalls += 1;
        return { ok: true, ctx: { project: "resolved" }, meta: { scopes: ["read"] } };
      },
    });

    const initialize = await app.handle(request({ jsonrpc: "2.0", id: 1, method: "initialize" }));
    const list = await app.handle(request({ jsonrpc: "2.0", id: 2, method: "tools/list" }));

    expect(initialize.status).toBe(200);
    expect(list.status).toBe(200);
    expect(connectionCalls).toBe(2);
    expect(contextCalls).toBe(0);
  });

  it("resolves project context for tools/call", async () => {
    let connectionCalls = 0;
    let contextCalls = 0;
    const app = bindHttp({
      path: "/test",
      logScope: "mcp-test",
      bundle: {
        name: "test",
        version: "1",
        specs: [
          {
            name: "echo",
            description: "Echo",
            inputSchema: z.object({}),
            handler: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
          },
        ],
      },
      resolveConnection: async () => {
        connectionCalls += 1;
        return { ok: true, meta: null };
      },
      resolveContext: async () => {
        contextCalls += 1;
        return { ok: true, ctx: { project: "resolved" }, meta: null };
      },
    });

    const response = await app.handle(
      request({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "echo", arguments: {} },
      }),
    );

    expect(response.status).toBe(200);
    expect(connectionCalls).toBe(0);
    expect(contextCalls).toBe(1);
  });

  it("keeps handshake responses when project resolution fails in a mixed batch", async () => {
    const app = bindHttp({
      path: "/test",
      logScope: "mcp-test",
      bundle: {
        name: "test",
        version: "1",
        specs: [
          {
            name: "echo",
            description: "Echo",
            inputSchema: z.object({}),
            handler: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
          },
        ],
      },
      resolveConnection: async () => ({ ok: true, meta: null }),
      resolveContext: async () => ({
        ok: false,
        status: 400,
        message: "Missing or invalid checkout identity",
      }),
    });

    const response = await app.handle(
      request([
        { jsonrpc: "2.0", id: 1, method: "initialize" },
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "echo", arguments: {} },
        },
      ]),
    );
    const body = (await response.json()) as Array<Record<string, unknown>>;

    expect(response.status).toBe(200);
    expect(body[0]).toHaveProperty("result");
    expect(body[1]).toMatchObject({
      error: {
        code: -32000,
        message: "Missing or invalid checkout identity",
        data: { httpStatus: 400 },
      },
    });
  });
});
