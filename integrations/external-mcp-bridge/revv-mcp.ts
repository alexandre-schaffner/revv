#!/usr/bin/env bun

// Revv's stdio MCP bridge: one dependency-free proxy shared by every external
// coding agent Revv supports (Claude Code, Codex, OpenCode, Cursor). Revv
// copies this file into the per-agent install directory and injects the
// credential through the environment; the agent speaks stdio JSON-RPC to it,
// and it forwards each frame to Revv's loopback MCP route together with the
// checkout identity.
//
// The bridge holds no review state: SQLite inside Revv stays authoritative.

import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";

interface ProjectIdentity {
  readonly repositoryFullName: string;
  readonly headCandidates: readonly string[];
  readonly branch: string | null;
}

interface JsonRpcRequest {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly method?: unknown;
}

type JsonRpcPayload = JsonRpcRequest | JsonRpcRequest[];

const token = process.env.REVV_INTEGRATION_TOKEN?.trim() ?? "";
/**
 * The server that installed this copy writes its own URL into
 * `REVV_API_URL`, and rewrites it on every start. Configs written before it
 * did probe Revv's two channels, production then development (`API_PORT`,
 * `DEV_API_PORT` in `@revv/shared`; `scripts/check-desktop-contract.ts` holds
 * them equal) until a Revv that pins them starts (legacy-upgrade: unpinnedBridge).
 */
const LEGACY_PORTS = [45678, 45679];
const configuredEndpoints = process.env.REVV_API_URL?.trim();
const endpoints = configuredEndpoints
  ? configuredEndpoints
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  : LEGACY_PORTS.map((port) => `http://127.0.0.1:${port}/mcp/external`);
// Bun sends even loopback requests through HTTP_PROXY unless NO_PROXY names
// the host; a proxy would answer instead of Revv (with a 407, say).
process.env.NO_PROXY = [process.env.NO_PROXY, process.env.no_proxy, "127.0.0.1", "localhost"]
  .filter(Boolean)
  .join(",");
// Agents differ in how they announce the active project: Claude Code exports
// `CLAUDE_PROJECT_DIR`, the others spawn the server with the workspace as cwd.
const projectDir =
  process.env.REVV_PROJECT_DIR?.trim() || process.env.CLAUDE_PROJECT_DIR?.trim() || process.cwd();

/** Every tool is a local DB write plus at most one GitHub round-trip. */
const REQUEST_TIMEOUT_MS = 120_000;

function git(args: readonly string[]): string {
  const result = spawnSync("git", ["-C", projectDir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    const detail = result.stderr.trim() || `git exited with ${result.status ?? "unknown status"}`;
    throw new Error(detail);
  }
  return result.stdout.trim();
}

function repositoryFullName(remoteUrl: string): string {
  const trimmed = remoteUrl.trim().replace(/\.git$/i, "");
  const scp = /^[^@]+@[^:]+:(.+)$/.exec(trimmed);
  const path =
    scp?.[1] ??
    (() => {
      try {
        return new URL(trimmed).pathname.replace(/^\//, "");
      } catch {
        return "";
      }
    })();
  const segments = path.split("/").filter(Boolean);
  if (segments.length < 2) {
    throw new Error("could not derive owner/repository from git remote");
  }
  return `${segments.at(-2)}/${segments.at(-1)}`;
}

function resolveProject(): ProjectIdentity {
  const remoteUrl = git(["remote", "get-url", "origin"]);
  const heads = git(["rev-list", "--max-count=64", "HEAD"])
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);
  if (heads.length === 0) throw new Error("the checkout has no commits");
  const branch = git(["branch", "--show-current"]);
  return {
    repositoryFullName: repositoryFullName(remoteUrl),
    headCandidates: heads,
    branch: branch || null,
  };
}

function rpcError(request: JsonRpcPayload, message: string): string | null {
  if (Array.isArray(request)) {
    const responses = request.flatMap((item) => {
      const response = rpcError(item, message);
      return response === null ? [] : [JSON.parse(response) as unknown];
    });
    return responses.length > 0 ? JSON.stringify(responses) : null;
  }
  if (!("id" in request) || request.id === undefined) return null;
  return JSON.stringify({
    jsonrpc: "2.0",
    id: request.id,
    error: { code: -32000, message },
  });
}

function requiresProject(request: JsonRpcPayload): boolean {
  return Array.isArray(request)
    ? request.some((item) => item.method === "tools/call")
    : request.method === "tools/call";
}

function includesConnectionOnlyRequest(request: JsonRpcPayload): boolean {
  return Array.isArray(request) && request.some((item) => item.method !== "tools/call");
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  if (!line.trim()) continue;

  let request: JsonRpcPayload;
  try {
    request = JSON.parse(line) as JsonRpcPayload;
  } catch {
    process.stderr.write("[revv] ignored invalid JSON-RPC input\n");
    continue;
  }

  if (!token) {
    const response = rpcError(
      request,
      "Revv is not connected to this agent. Reconnect it from Revv Settings → Integrations.",
    );
    if (response) process.stdout.write(`${response}\n`);
    continue;
  }

  let project: ProjectIdentity | null = null;
  if (requiresProject(request)) {
    try {
      // A long-lived agent can switch branches or worktrees. Identity is
      // request-scoped so the next tool call follows the current checkout.
      project = resolveProject();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (!includesConnectionOnlyRequest(request)) {
        const response = rpcError(request, `Revv could not identify this checkout: ${detail}`);
        if (response) process.stdout.write(`${response}\n`);
        continue;
      }
      // Forward mixed batches without checkout headers. Revv can still answer
      // initialize/tools/list and returns a scoped JSON-RPC error only for the
      // tools/call entry that needs project context.
    }
  }

  let handled = false;
  // The first answer Revv gave stays the reason: an endpoint tried after it
  // that can't be reached says nothing about the credential it refused.
  let answered: string | null = null;
  let unreachable = "No Revv endpoint was available.";
  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...(project
            ? {
                "X-Revv-Repository": project.repositoryFullName,
                "X-Revv-Head-Candidates": project.headCandidates.join(","),
                ...(project.branch ? { "X-Revv-Branch": project.branch } : {}),
              }
            : {}),
        },
        body: line,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const body = await response.text();
      if (!response.ok) {
        const detail = body.trim() || response.statusText || "no response body";
        const failure = `Revv returned HTTP ${response.status}: ${detail}`;
        answered ??= failure;
        const couldBeWrongChannel =
          response.status === 401 ||
          response.status === 403 ||
          (response.status === 404 && body.trim() === "");
        if (couldBeWrongChannel) continue;
        const reply = rpcError(request, failure);
        if (reply) process.stdout.write(`${reply}\n`);
        handled = true;
        break;
      }
      if (body.length === 0) {
        const failure = rpcError(request, "Revv accepted the request but returned no response.");
        if (failure) process.stdout.write(`${failure}\n`);
      } else {
        process.stdout.write(`${body}\n`);
      }
      handled = true;
      break;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      unreachable = `Cannot reach Revv. Keep the app running in the tray and retry. (${detail})`;
    }
  }
  if (!handled) {
    const failure = rpcError(request, answered ?? unreachable);
    if (failure) process.stdout.write(`${failure}\n`);
  }
}
