// ─── recap-tools ─────────────────────────────────────────────────────────────
//
// Public surface for the project-recap MCP tool set. Re-exports the schemas,
// the handler types, and constructs the Claude Agent SDK adapter so
// `ProjectRecapJobs` can spawn an agent with these tools in-process.
//
// HTTP MCP transport (for opencode parity) is not implemented in v1 — see
// the plan's "Out of Scope" section. The shared handlers in `handlers.ts`
// are reusable from a future HTTP route without rewriting any logic.

import { bindInProcess, type ToolSpecBundle } from "../mcp-tool-gateway";
import {
  addPrEntryHandler,
  completeRecapHandler,
  getPrDiffHandler,
  getRecapStateHandler,
  getRepoContextHandler,
  listOpenPrsHandler,
  setLedeHandler,
  setThemeSummaryHandler,
} from "./handlers";
import {
  addPrEntrySchema,
  completeRecapSchema,
  getPrDiffSchema,
  getRecapStateSchema,
  getRepoContextSchema,
  listOpenPrsSchema,
  type RecapToolContext,
  type RecapToolResult,
  type RecapToolSpecRecord,
  setLedeSchema,
  setThemeSummarySchema,
} from "./spec";

export type {
  AddPrEntryInput,
  CompleteRecapInput,
  GetPrDiffInput,
  GetRecapStateInput,
  GetRepoContextInput,
  ListOpenPrsInput,
  RecapSourceBundle,
  RecapSourcePr,
  RecapSourcePrDiff,
  RecapSourcePrDiffFile,
  RecapSourcePrDigest,
  RecapToolContext,
  RecapToolHandler,
  RecapToolResult,
  SetLedeInput,
  SetThemeSummaryInput,
} from "./spec";
export {
  addPrEntryHandler,
  completeRecapHandler,
  getPrDiffHandler,
  getRecapStateHandler,
  getRepoContextHandler,
  listOpenPrsHandler,
  setLedeHandler,
  setThemeSummaryHandler,
};

export const RECAP_TOOL_SPECS: RecapToolSpecRecord[] = [
  {
    name: "get_recap_state",
    description:
      "Read-only. Call FIRST on every run, including resumes. Returns the period boundaries, the list of archived PRs in this window (with author, branches, +/-, body excerpt), and each PR's latest complete walkthrough (summary, sentiment, risk level) when available. For PRs without walkthroughs, use the compact diffDigest already ingested by the server. Open PRs are NOT inlined — only their count is — fetch them via list_open_prs. Use this as the source of truth for the recap — do not invent PRs or walkthroughs.",
    inputSchema: getRecapStateSchema,
    handler: getRecapStateHandler,
  },
  {
    name: "get_pr_diff",
    description:
      "Read-only fallback. Returns the compact pre-ingested diffDigest for a PR when available; raw diff loading is only a compatibility fallback when a digest is unexpectedly missing. Prefer get_recap_state.diffDigest and do not call this in the normal recap flow.",
    inputSchema: getPrDiffSchema,
    handler: getPrDiffHandler,
  },
  {
    name: "list_open_prs",
    description:
      "Read-only. Paginated fetch over currently open PRs (capped server-side at 20 most recently updated). Open PRs are FIRST-CLASS recap entries — call add_pr_entry for the worthwhile ones (present-tense verb/description). The UI renders open entries as an 'In progress' subgroup inside each theme chapter, alongside the shipped entries. Default page size 5; pass `nextOffset` from the response to walk pages.",
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
    name: "set_lede",
    description:
      "Atomic write. Call ONCE before adding entries. Persists a 1–3 sentence editorial lede summarizing the period. Plain text + optional `<strong>` / `<em>` only; everything else is stripped. Idempotent — calling again overwrites the prior lede.",
    inputSchema: setLedeSchema,
    handler: setLedeHandler,
  },
  {
    name: "add_pr_entry",
    description:
      "Atomic idempotent write. Call ONCE per PR you want in the recap. Upserts on (recap_id, pr_id) — re-calling with the same pr_id replaces the row in place. Pick a SHORT, REUSABLE theme label (lowercase noun) that groups this PR with related work — the UI chapters by theme. Skip pure chores/typo fixes at your editorial discretion.",
    inputSchema: addPrEntrySchema,
    handler: addPrEntryHandler,
  },
  {
    name: "set_theme_summary",
    description:
      "Atomic idempotent write. Call ONCE per distinct theme you used in add_pr_entry, AFTER all add_pr_entry calls. Persists a 1–2 sentence editorial summary that the UI renders as a small lede paragraph below the theme heading. Upserts on (recap_id, theme) — re-calling with the same theme overwrites in place. Use the same lowercase label you passed to add_pr_entry; server normalizes (lowercase + trim + collapse whitespace) before keying. Optional but strongly encouraged — chapters read much better with a sentence framing what landed.",
    inputSchema: setThemeSummarySchema,
    handler: setThemeSummaryHandler,
  },
  {
    name: "complete_recap",
    description:
      "Validation gate. Call LAST. Asserts the lede is non-empty AND at least one PR entry exists. Stamps the recap's derived fields (summary_stats from the source bundle, source_pr_ids + source_walkthrough_ids from the entries) and signals the orchestrator to flip status='complete'. After this returns success, you may stop emitting tool calls.",
    inputSchema: completeRecapSchema,
    handler: completeRecapHandler,
  },
];

export const RECAP_TOOL_BUNDLE: ToolSpecBundle<RecapToolContext, RecapToolResult> = {
  name: "revv-recap",
  version: "1.0.0",
  specs: RECAP_TOOL_SPECS,
};

/**
 * Build the Claude Agent SDK MCP server registration scoped to a single
 * recap job. The orchestrator passes the per-job context (recap id +
 * source bundle + prior recaps + onCompleted hook) through here.
 */
export function createRecapMcpServer(ctx: RecapToolContext): ReturnType<typeof bindInProcess> {
  return bindInProcess(RECAP_TOOL_BUNDLE, ctx, {
    beforeToolCall: (toolName, boundCtx) => {
      boundCtx.toolCalls?.add(toolName);
    },
  });
}

/** Canonical MCP-server name; mirrors the walkthrough's `revv-walkthrough`. */
export const RECAP_MCP_SERVER = "revv-recap";

/** Tool prefix the Claude SDK applies to MCP-server tools. */
export const RECAP_TOOL_PREFIX = `mcp__${RECAP_MCP_SERVER}__`;

/** Allowed-tools list to pass into `query()` so the SDK surfaces our tools. */
export const RECAP_ALLOWED_TOOLS = RECAP_TOOL_SPECS.map((s) => `${RECAP_TOOL_PREFIX}${s.name}`);
