/**
 * Standalone MCP stdio server for walkthrough tools.
 * Run via: bun run walkthrough-stdio-server.ts
 *
 * Exposes the same 7 walkthrough tools over stdio so opencode can call them
 * via its MCP integration. State is pre-seeded from environment variables so
 * continuation runs pick up the correct block/issue/axis counters.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { RatingAxis } from "@revv/shared";
import { TOOL_SPECS, createInitialState } from "./walkthrough-tool-spec.js";

// ── Seed state from environment variables ────────────────────────────────────

const state = createInitialState();
state.blockCount = parseInt(process.env["REVV_WT_BLOCK_COUNT"] ?? "0", 10);
state.issueCount = parseInt(process.env["REVV_WT_ISSUE_COUNT"] ?? "0", 10);
state.summarySet = process.env["REVV_WT_SUMMARY_SET"] === "true";
state.writingPhaseEmitted = state.blockCount > 0;

const ratedAxesRaw = process.env["REVV_WT_RATED_AXES"] ?? "[]";
try {
	const parsed = JSON.parse(ratedAxesRaw) as RatingAxis[];
	for (const axis of parsed) {
		state.ratedAxes.add(axis);
	}
} catch {
	// Malformed env var — start with no rated axes
}

// ── Create and configure MCP server ─────────────────────────────────────────

const server = new McpServer({
	name: "revv-walkthrough",
	version: "1.0.0",
});

for (const spec of TOOL_SPECS) {
	// The emit function is a no-op: the parent Revv process reconstructs events
	// by observing `tool_use` frames in opencode's `--format json` stdout stream.
	// The stdio server's only job is validation and returning proper tool results.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	server.tool(spec.name, spec.description, spec.inputSchema.shape, async (args: any) => {
		return spec.handler(args, state, () => {
			/* no-op emit */
		});
	});
}

// ── Connect and start ────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
