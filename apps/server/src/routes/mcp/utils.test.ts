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

const echoProject = {
  name: "test",
  version: "1",
  specs: [
    {
      name: "echo",
      description: "Echo",
      inputSchema: z.object({}),
      handler: async (ctx: { project: string }) => ({
        content: [{ type: "text" as const, text: ctx.project }],
      }),
    },
  ],
};

describe("bindHttp connection resolution", () => {
  it("answers initialize and tools/list on the credential alone, without a project", async () => {
    const app = bindHttp({
      path: "/test",
      logScope: "mcp-test",
      bundle: echoProject,
      resolveConnection: async () => ({ ok: true, meta: null }),
      resolveContext: async () => ({ ok: false, status: 400, message: "no checkout" }),
    });

    const initialize = await app.handle(request({ jsonrpc: "2.0", id: 1, method: "initialize" }));
    const list = await app.handle(request({ jsonrpc: "2.0", id: 2, method: "tools/list" }));

    expect(initialize.status).toBe(200);
    expect(await initialize.json()).toHaveProperty("result.serverInfo.name", "test");
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ result: { tools: [{ name: "echo" }] } });
  });

  it("refuses the handshake when the credential doesn't resolve", async () => {
    const app = bindHttp({
      path: "/test",
      logScope: "mcp-test",
      bundle: echoProject,
      resolveConnection: async () => ({ ok: false, status: 401, message: "Missing bearer token" }),
      resolveContext: async () => ({ ok: true, ctx: { project: "resolved" }, meta: null }),
    });

    const response = await app.handle(request({ jsonrpc: "2.0", id: 1, method: "initialize" }));

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { message: "Missing bearer token" } });
  });

  it("hands tools/call the resolved project context", async () => {
    const app = bindHttp({
      path: "/test",
      logScope: "mcp-test",
      bundle: echoProject,
      resolveConnection: async () => ({ ok: true, meta: null }),
      resolveContext: async () => ({ ok: true, ctx: { project: "resolved" }, meta: null }),
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
    expect(await response.json()).toMatchObject({
      result: { content: [{ type: "text", text: "resolved" }] },
    });
  });

  it("keeps handshake responses when project resolution fails in a mixed batch", async () => {
    const app = bindHttp({
      path: "/test",
      logScope: "mcp-test",
      bundle: echoProject,
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
