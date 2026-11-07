// The phase window of each write tool: the phase it belongs to (its
// description opens with it) and the completed phases a call may follow. A
// call outside its window is refused before anything is written (invariant 5),
// and so is every call on a row that is no longer generating: a superseded or
// finished review is never written by the generation pipeline (invariant 7).

import type { WalkthroughPipelinePhase } from "@revv/shared";
import type { Db } from "../../../db";
import { loadWalkthroughRow, type WalkthroughRow } from "../../../services/walkthrough/content";
import { fail } from "../mcp-tool-gateway";
import type { WalkthroughToolResult } from "./spec";

interface PhaseWindow {
  /** Null for the completion gate, which belongs to no phase. */
  readonly label: string | null;
  readonly after: readonly WalkthroughPipelinePhase[];
  readonly refusal: (phase: WalkthroughPipelinePhase) => string;
}

export const TOOL_PHASES = {
  set_overview: {
    label: "Phase A",
    after: ["none"],
    refusal: (phase) =>
      `Error: set_overview can only be called once, before any other tool. Current phase: '${phase}'. If you're resuming, call get_walkthrough_state first — the overview has already been set.`,
  },
  add_semantic_step: {
    label: "Phase B",
    after: ["A", "B"],
    refusal: (phase) =>
      `Error: add_semantic_step requires Phase A complete and Phase C not yet entered. Current phase: '${phase}'. Call set_overview first, or stop adding chapters once sentiment has been set.`,
  },
  add_diff_step: {
    label: "Phase B",
    after: ["B"],
    refusal: (phase) =>
      `Error: add_diff_step requires Phase B (open via add_semantic_step) and Phase C not yet entered. Current phase: '${phase}'. ${phase === "A" ? "Call add_semantic_step first to open the first chapter — it advances the pipeline to Phase B and creates the parent row this block attaches to." : "Stop adding diff steps once sentiment has been set."}`,
  },
  flag_issue: {
    label: "Phase B",
    after: ["A", "B"],
    refusal: (phase) =>
      `Error: flag_issue is only valid during Phase A/B. Current phase: '${phase}'.`,
  },
  add_issue_comment: {
    label: "Phase B",
    after: ["A", "B"],
    refusal: (phase) =>
      `Error: add_issue_comment is only valid during Phase A/B. Current phase: '${phase}'. Comments are line-level evidence for issues; they belong with the diff analysis, not after sentiment or rating.`,
  },
  // Later phases are allowed on purpose: complete_walkthrough is where an
  // unresolved lead is first refused, and a rejection needs no Phase-B write.
  resolve_lead: {
    label: "Phase B onward",
    after: ["A", "B", "C", "D"],
    refusal: () => "Error: resolve_lead requires the overview (Phase A). Call set_overview first.",
  },
  set_sentiment: {
    label: "Phase C",
    after: ["B"],
    refusal: (phase) =>
      `Error: set_sentiment requires Phase B complete (at least one diff step persisted). Current phase: '${phase}'. Add diff steps first.`,
  },
  rate_axis: {
    label: "Phase D",
    after: ["C", "D"],
    refusal: (phase) =>
      `Error: rate_axis requires Phase C complete (sentiment set). Current phase: '${phase}'. Call set_sentiment first.`,
  },
  complete_walkthrough: {
    label: null,
    after: ["D"],
    refusal: (phase) =>
      `Error: complete_walkthrough requires Phase D complete (all 9 axes rated). Current phase: '${phase}'.`,
  },
} as const satisfies Record<string, PhaseWindow>;

export type WriteToolName = keyof typeof TOOL_PHASES;

export function phaseDescription(tool: WriteToolName, description: string): string {
  const { label } = TOOL_PHASES[tool];
  return label === null ? description : `${label}. ${description}`;
}

/**
 * The walkthrough row and its completed phase, read inside the caller's
 * transaction, or the refusal `tool` owes the agent.
 */
export function openForWrite(
  db: Db,
  walkthroughId: string,
  tool: WriteToolName,
):
  | { readonly row: WalkthroughRow; readonly phase: WalkthroughPipelinePhase }
  | { readonly refusal: WalkthroughToolResult } {
  const row = loadWalkthroughRow(db, walkthroughId);
  if (!row) return { refusal: fail(`Walkthrough ${walkthroughId} not found.`) };
  if (row.status !== "generating") {
    return {
      refusal: fail(
        `Error: this walkthrough is no longer generating (it is '${row.status}'). Nothing was written; stop here.`,
      ),
    };
  }
  const phase = row.lastCompletedPhase as WalkthroughPipelinePhase;
  const window: PhaseWindow = TOOL_PHASES[tool];
  if (!window.after.includes(phase)) return { refusal: fail(window.refusal(phase)) };
  return { row, phase };
}
