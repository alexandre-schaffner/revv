// Drives the real stdio bridge as a subprocess. The contract under test is
// narrow but load-bearing: a JSON-RPC request carrying an `id` must ALWAYS get
// exactly one response line back. Anything less hangs the calling agent
// forever with no diagnostic — which is what a stale endpoint path did, since
// an unmatched Elysia route 404s with an empty body.

import { afterEach, describe, expect, it } from "bun:test";
import { resolve } from "node:path";

const BRIDGE = resolve(
  import.meta.dir,
  "../../../../../integrations/external-mcp-bridge/revv-mcp.ts",
);
const REQUEST = `${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" })}\n`;

const servers: { stop: () => void }[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
});

/** A stand-in Revv endpoint that answers every request the same way. */
function stubRevv(respond: () => Response): string {
  const server = Bun.serve({ port: 0, fetch: respond });
  servers.push({ stop: () => server.stop(true) });
  return `http://127.0.0.1:${server.port}/mcp/external`;
}

async function askBridge(apiUrl: string): Promise<string> {
  const child = Bun.spawn(["bun", "run", BRIDGE], {
    cwd: resolve(import.meta.dir, "../../../../.."),
    env: {
      ...process.env,
      REVV_INTEGRATION_TOKEN: "test-token",
      REVV_API_URL: apiUrl,
    },
    stdin: new TextEncoder().encode(REQUEST),
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = await new Response(child.stdout).text();
  await child.exited;
  return output.trim();
}

describe("external MCP bridge", () => {
  it("answers an id-bearing request even when the endpoint 404s with an empty body", async () => {
    const url = stubRevv(() => new Response(null, { status: 404 }));

    const output = await askBridge(url);

    expect(output).not.toBe("");
    const response = JSON.parse(output) as { id: number; error?: { message: string } };
    expect(response.id).toBe(7);
    expect(response.error?.message).toContain("404");
  });

  it("answers an id-bearing request when a 200 comes back with no body", async () => {
    const url = stubRevv(() => new Response("", { status: 200 }));

    const output = await askBridge(url);

    const response = JSON.parse(output) as { id: number; error?: { message: string } };
    expect(response.id).toBe(7);
    expect(response.error?.message).toContain("no response");
  });

  it("passes a successful response through untouched", async () => {
    const url = stubRevv(
      () =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 7, result: { tools: [] } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const output = await askBridge(url);

    expect(JSON.parse(output)).toEqual({ jsonrpc: "2.0", id: 7, result: { tools: [] } });
  });

  it("reports an unreachable Revv instead of waiting on it", async () => {
    // Port 1 is reserved and never listening on loopback.
    const output = await askBridge("http://127.0.0.1:1/mcp/external");

    const response = JSON.parse(output) as { id: number; error?: { message: string } };
    expect(response.id).toBe(7);
    expect(response.error?.message).toContain("Cannot reach Revv");
  });
});
