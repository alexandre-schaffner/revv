// Specs for the `/mcp/recap` HTTP MCP route, the single transport every ACP
// agent reaches (see `recap-acp.ts`).

import { defineTool, type ToolSpecBundle } from "../mcp-tool-gateway";
import {
  addPrEntryHandler,
  completeRecapHandler,
  getPrDiffHandler,
  getRecapStateHandler,
  getRepoContextHandler,
  listOpenPrsHandler,
  recapCompletionBlocker,
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
  setLedeSchema,
  setThemeSummarySchema,
} from "./spec";

export type { RecapSourcePrDiff, RecapSourcePrDiffFile, RecapToolContext } from "./spec";
export { recapCompletionBlocker };

const tool = defineTool<RecapToolContext, RecapToolResult>();

export const RECAP_TOOL_BUNDLE: ToolSpecBundle<RecapToolContext, RecapToolResult> = {
  name: "revv-recap",
  version: "1.0.0",
  route: "/mcp/recap",
  specs: [
    tool({
      name: "get_recap_state",
      access: "read",
      description:
        "Read-only. Call FIRST on every run, including resumes. Returns the period boundaries, the list of archived PRs in this window (with author, branches, +/-, body excerpt), and each PR's latest complete walkthrough (summary, sentiment, risk level) when available. For PRs without walkthroughs, use the compact diffDigest already ingested by the server. Open PRs are NOT inlined — only their count is — fetch them via list_open_prs. Use this as the source of truth for the recap — do not invent PRs or walkthroughs.",
      activity: { kind: "tool.read", summary: "Reading recap state" },
      inputSchema: getRecapStateSchema,
      handler: getRecapStateHandler,
    }),
    tool({
      name: "get_pr_diff",
      access: "read",
      description:
        "Read-only fallback. Returns the compact pre-ingested diffDigest for a PR when available; raw diff loading is only a compatibility fallback when a digest is unexpectedly missing. Prefer get_recap_state.diffDigest and do not call this in the normal recap flow.",
      activity: {
        kind: "tool.read",
        summary: ({ pr_id }) => (pr_id ? `Reading PR diff ${pr_id}` : "Reading PR diff"),
      },
      inputSchema: getPrDiffSchema,
      handler: getPrDiffHandler,
    }),
    tool({
      name: "list_open_prs",
      access: "read",
      description:
        "Read-only. Paginated fetch over currently open PRs (capped server-side at 20 most recently updated). Open PRs are FIRST-CLASS recap entries — call add_pr_entry for the worthwhile ones (present-tense verb/description). The UI renders open entries as an 'In progress' subgroup inside each theme chapter, alongside the shipped entries. Default page size 5; pass `nextOffset` from the response to walk pages.",
      activity: { kind: "tool.ls", summary: "Listing open pull requests" },
      inputSchema: listOpenPrsSchema,
      handler: listOpenPrsHandler,
    }),
    tool({
      name: "get_repo_context",
      access: "read",
      description:
        "Read-only. Returns prior recaps for this repo (most-recent first), so the new recap can build on rolling context rather than restating. Empty when this is the first recap for the repo.",
      activity: { kind: "tool.read", summary: "Reading prior recaps" },
      inputSchema: getRepoContextSchema,
      handler: getRepoContextHandler,
    }),
    tool({
      name: "set_lede",
      access: "write",
      description:
        "Atomic write. Call ONCE before adding entries. Persists a 1–3 sentence editorial lede summarizing the period. Plain text + optional `<strong>` / `<em>` only; everything else is stripped. Idempotent — calling again overwrites the prior lede.",
      activity: { kind: "tool.write", summary: "Writing lede" },
      inputSchema: setLedeSchema,
      handler: setLedeHandler,
    }),
    tool({
      name: "add_pr_entry",
      access: "write",
      description:
        "Atomic idempotent write. Call ONCE per PR you want in the recap. Upserts on (recap_id, pr_id) — re-calling with the same pr_id replaces the row in place. Pick a SHORT, REUSABLE theme label (lowercase noun) that groups this PR with related work — the UI chapters by theme. Skip pure chores/typo fixes at your editorial discretion.",
      activity: {
        kind: "tool.write",
        summary: ({ pr_id, theme, verb }) => {
          if (verb && theme) return `Cataloguing PR — ${verb} (${theme})`;
          if (theme) return `Cataloguing PR (${theme})`;
          return pr_id ? `Cataloguing PR ${pr_id}` : "Cataloguing PR";
        },
      },
      inputSchema: addPrEntrySchema,
      handler: addPrEntryHandler,
    }),
    tool({
      name: "set_theme_summary",
      access: "write",
      description:
        "Atomic idempotent write. Call ONCE per distinct theme you used in add_pr_entry, AFTER all add_pr_entry calls. Persists a 1–2 sentence editorial summary that the UI renders as a small lede paragraph below the theme heading. Upserts on (recap_id, theme) — re-calling with the same theme overwrites in place. Use the same lowercase label you passed to add_pr_entry; server normalizes (lowercase + trim + collapse whitespace) before keying. Optional but strongly encouraged — chapters read much better with a sentence framing what landed.",
      activity: {
        kind: "tool.write",
        summary: ({ theme }) =>
          theme ? `Writing theme summary (${theme})` : "Writing theme summary",
      },
      inputSchema: setThemeSummarySchema,
      handler: setThemeSummaryHandler,
    }),
    tool({
      name: "complete_recap",
      access: "write",
      description:
        "Validation gate. Call LAST. Asserts the lede is non-empty AND at least one PR entry exists, then signals the orchestrator to flip status='complete'. After this returns success, you may stop emitting tool calls.",
      activity: { kind: "tool.mcp", summary: "Finalizing recap" },
      inputSchema: completeRecapSchema,
      handler: completeRecapHandler,
    }),
  ],
};
