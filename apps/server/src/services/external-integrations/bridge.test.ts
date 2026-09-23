// Drives the real stdio bridge as a subprocess. The contract under test is
// narrow but load-bearing: a JSON-RPC request carrying an `id` must ALWAYS get
// exactly one response line back. Anything less hangs the calling agent
// forever with no diagnostic — which is what a stale endpoint path did, since
// an unmatched Elysia route 404s with an empty body.

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const BRIDGE = resolve(
  import.meta.dir,
  "../../../../../integrations/external-mcp-bridge/revv-mcp.ts",
);
const REQUEST = `${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" })}\n`;

const servers: { stop: () => void }[] = [];
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** A stand-in Revv endpoint that answers every request the same way. */
function stubRevv(respond: (request: Request) => Response): string {
  const server = Bun.serve({ port: 0, fetch: respond });
  servers.push({ stop: () => server.stop(true) });
  return `http://127.0.0.1:${server.port}/mcp/external`;
}

async function askBridge(
  apiUrl: string,
  cwd: string = resolve(import.meta.dir, "../../../../.."),
  input: string = REQUEST,
): Promise<string> {
  const child = Bun.spawn(["bun", "run", BRIDGE], {
    cwd,
    env: {
      ...process.env,
      REVV_INTEGRATION_TOKEN: "test-token",
      REVV_API_URL: apiUrl,
    },
    stdin: new TextEncoder().encode(input),
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

  it("completes tools/list without requiring a git checkout identity", async () => {
    const directory = mkdtempSync(join(tmpdir(), "revv-bridge-no-git-"));
    temporaryDirectories.push(directory);
    let repositoryHeader: string | null = "not-called";
    const url = stubRevv((request) => {
      repositoryHeader = request.headers.get("X-Revv-Repository");
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 7, result: { tools: [] } }));
    });

    const output = await askBridge(url, directory);

    expect(JSON.parse(output)).toEqual({ jsonrpc: "2.0", id: 7, result: { tools: [] } });
    expect(repositoryHeader).toBeNull();
  });

  it("forwards a mixed batch without checkout headers when git identity is unavailable", async () => {
    const directory = mkdtempSync(join(tmpdir(), "revv-bridge-mixed-no-git-"));
    temporaryDirectories.push(directory);
    let repositoryHeader: string | null = "not-called";
    const replies = [
      { jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "revv-review" } } },
      { jsonrpc: "2.0", id: 2, error: { code: -32000, message: "Missing checkout identity" } },
    ];
    const url = stubRevv((request) => {
      repositoryHeader = request.headers.get("X-Revv-Repository");
      return new Response(JSON.stringify(replies));
    });
    const input = `${JSON.stringify([
      { jsonrpc: "2.0", id: 1, method: "initialize" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo" } },
    ])}\n`;

    const output = await askBridge(url, directory, input);

    expect(JSON.parse(output)).toEqual(replies);
    expect(repositoryHeader).toBeNull();
  });

  it("reports an unreachable Revv instead of waiting on it", async () => {
    // Port 1 is reserved and never listening on loopback.
    const output = await askBridge("http://127.0.0.1:1/mcp/external");

    const response = JSON.parse(output) as { id: number; error?: { message: string } };
    expect(response.id).toBe(7);
    expect(response.error?.message).toContain("Cannot reach Revv");
  });
});
