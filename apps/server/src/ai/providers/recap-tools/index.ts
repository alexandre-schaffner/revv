// ─── recap-tools ─────────────────────────────────────────────────────────────
//
// Public surface for the project-recap MCP tool set. Re-exports the schemas,
// the handler types, and constructs the Claude Agent SDK adapter so
// `ProjectRecapJobs` can spawn an agent with these tools in-process.
//
// HTTP MCP transport (for opencode parity) is not implemented in v1 — see
// the plan's "Out of Scope" section. The shared handlers in `handlers.ts`
// are reusable from a future HTTP route without rewriting any logic.

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import {
  commitRecapOverviewHandler,
  completeRecapHandler,
  getPrDiffHandler,
  getRecapStateHandler,
  getRepoContextHandler,
  listOpenPrsHandler,
} from "./handlers";
import {
  commitRecapOverviewSchema,
  completeRecapSchema,
  getPrDiffSchema,
  getRecapStateSchema,
  getRepoContextSchema,
  listOpenPrsSchema,
  type RecapToolContext,
  type RecapToolSpec,
} from "./spec";

export type {
  CommitRecapOverviewInput,
  CompleteRecapInput,
  GetPrDiffInput,
  GetRecapStateInput,
  GetRepoContextInput,
  ListOpenPrsInput,
  RecapSourceBundle,
  RecapSourcePr,
  RecapSourcePrDiff,
  RecapSourcePrDiffFile,
  RecapToolContext,
  RecapToolHandler,
  RecapToolResult,
  RecapToolSpec,
} from "./spec";
export {
  commitRecapOverviewHandler,
  completeRecapHandler,
  getPrDiffHandler,
  getRecapStateHandler,
  getRepoContextHandler,
  listOpenPrsHandler,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const RECAP_TOOL_SPECS: Array<RecapToolSpec<any>> = [
  {
    name: "get_recap_state",
    description:
      "Read-only. Call FIRST on every run, including resumes. Returns the period boundaries, the list of archived PRs in this window (with author, branches, +/-, body excerpt), and each PR's latest complete walkthrough (summary, sentiment, risk level) when available. Diffs are NOT inlined — call get_pr_diff for individual PRs where walkthrough is null. Open PRs are also NOT inlined — only their count is — fetch them via list_open_prs. Use this as the source of truth for the recap — do not invent PRs or walkthroughs.",
    inputSchema: getRecapStateSchema,
    handler: getRecapStateHandler,
  },
  {
    name: "get_pr_diff",
    description:
      "Read-only. Fetch the file-level diff for a single archived PR by its `id`. Call this for PRs where `walkthrough` is null to get per-file status, +/- counts, and unified patch text. Each call returns one PR's diff — call it once per PR you want to inspect, BEFORE starting to write the markdown (a tool call mid-composition resets the buffer). Returns an error when the id is not in the source bundle or when diff data is unavailable.",
    inputSchema: getPrDiffSchema,
    handler: getPrDiffHandler,
  },
  {
    name: "list_open_prs",
    description:
      "Read-only. Paginated fetch over the currently open PRs that get_recap_state reported (already capped server-side at the 20 most recently updated). Start with offset=0; the response includes `nextOffset` — keep paging while it's non-null, then stop. Default page size is 5; raise it only if you have a reason. Each row carries author, branches, +/- stats, a body excerpt, and the latest complete walkthrough when one exists. Use these rows to write the 'Active work' section.",
    inputSchema: listOpenPrsSchema,
    handler: listOpenPrsHandler,
  },
  {
    name: "get_repo_context",
    description:
      "Read-only. Returns prior recaps for this repo (most-recent first), so the new recap can build on rolling context rather than restating. Empty when this is the first recap for the repo.",
    inputSchema: getRepoContextSchema,
    handler: getRepoContextHandler,
  },
  {
    name: "commit_recap_overview",
    description:
      "Atomic content write. Call ONCE after writing the complete recap as your visible assistant response. The server reads the markdown you just typed from the streaming buffer and persists it together with the provenance arrays (source_pr_ids + source_walkthrough_ids) and the pre-aggregated stats — you pass ONLY the metadata as arguments. Do not re-serialise the markdown here; if the buffer is empty you'll get an error pointing you back at composition. Idempotent — a retry with the same recapId replaces the prior content.",
    inputSchema: commitRecapOverviewSchema,
    handler: commitRecapOverviewHandler,
  },
  {
    name: "complete_recap",
    description:
      "Validation gate. Call LAST. Asserts the overview is non-empty and at least one source PR was included. Signals the orchestrator to flip status='complete'. After this call returns success, you may stop emitting tool calls.",
    inputSchema: completeRecapSchema,
    handler: completeRecapHandler,
  },
];

/**
 * Build the Claude Agent SDK MCP server registration scoped to a single
 * recap job. The orchestrator passes the per-job context (recap id +
 * source bundle + prior recaps + onCompleted hook) through here.
 */
export function createRecapMcpServer(ctx: RecapToolContext): ReturnType<typeof createSdkMcpServer> {
  return createSdkMcpServer({
    name: "revv-recap",
    version: "1.0.0",
    tools: RECAP_TOOL_SPECS.map((spec) =>
      tool(
        spec.name,
        spec.description,
        spec.inputSchema.shape,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async (args: any) => spec.handler(ctx, args),
      ),
    ),
  });
}

/** Canonical MCP-server name; mirrors the walkthrough's `revv-walkthrough`. */
export const RECAP_MCP_SERVER = "revv-recap";

/** Tool prefix the Claude SDK applies to MCP-server tools. */
export const RECAP_TOOL_PREFIX = `mcp__${RECAP_MCP_SERVER}__`;

/** Allowed-tools list to pass into `query()` so the SDK surfaces our tools. */
export const RECAP_ALLOWED_TOOLS = RECAP_TOOL_SPECS.map((s) => `${RECAP_TOOL_PREFIX}${s.name}`);
