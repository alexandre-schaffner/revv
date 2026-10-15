// ── Handler: resolve_lead (Phase B onward) ──────────────────────────────────
//
// The agent's verdict on one first-pass lead. The lead row was recorded by
// the orchestrator before the prompt went out; this writes only its verdict
// columns, keyed on (walkthrough_id, lead_key), so a replay is a no-op.
//
// Phase precondition: the overview is set (last_completed_phase ≠ 'none').
// Later phases are allowed on purpose — `complete_walkthrough` is where an
// unresolved lead is first refused, and a rejection needs no Phase-B write.

import type { WalkthroughLead, WalkthroughPipelinePhase } from "@revv/shared";
import { and, eq } from "drizzle-orm";
import type { Db } from "../../../db";
import { walkthroughIssues } from "../../../db/schema/walkthrough-issues";
import { walkthroughLeads } from "../../../db/schema/walkthrough-leads";
import { readWalkthroughLead, readWalkthroughLeads } from "../../../services/walkthrough-leads";
import { decodePlainText } from "../agent-text";
import { errorResult, loadWalkthroughRow, okResult } from "./helpers";
import type { ResolveLeadInput, WalkthroughToolHandler, WalkthroughToolResult } from "./spec";

/** Leads this walkthrough's agent was handed and hasn't resolved, in prompt order. */
export function findUnresolvedLeads(db: Db, walkthroughId: string): WalkthroughLead[] {
  return readWalkthroughLeads(db, walkthroughId).filter((lead) => lead.verdict === null);
}

export function renderUnresolvedLeadsError(leads: readonly WalkthroughLead[]): string {
  return `Error: ${leads.length} first-pass lead(s) have no verdict: ${leads
    .map((lead) => `${lead.id} (${lead.filePath}:${lead.newStart})`)
    .join(
      ", ",
    )}. Call resolve_lead for each — confirmed with the issue_id you raised for it, or rejected with a one-sentence reason — then call complete_walkthrough again.`;
}

export const resolveLeadHandler: WalkthroughToolHandler<ResolveLeadInput> = async (ctx, input) => {
  const reason = input.reason ? decodePlainText(input.reason).trim() : "";
  const issueId = input.issue_id?.trim() || null;

  const { result, event } = ctx.db.transaction(
    (): {
      result: WalkthroughToolResult;
      event?: WalkthroughLead;
    } => {
      const row = loadWalkthroughRow(ctx.db, ctx.walkthroughId);
      if (!row) return { result: errorResult(`Walkthrough ${ctx.walkthroughId} not found.`) };
      const phase = row.lastCompletedPhase as WalkthroughPipelinePhase;
      if (phase === "none") {
        return {
          result: errorResult(
            "Error: resolve_lead requires the overview (Phase A). Call set_overview first.",
          ),
        };
      }
      const lead = readWalkthroughLead(ctx.db, ctx.walkthroughId, input.lead_id);
      if (!lead) {
        return {
          result: errorResult(
            `Error: lead_id '${input.lead_id}' is not one of this walkthrough's first-pass leads. Use an id from the prompt's First-pass leads (e.g. \`L1\`); call get_walkthrough_state to list them.`,
          ),
        };
      }

      let linkedIssueId: string | null = null;
      let withdrawn = false;
      if (input.verdict === "confirmed") {
        if (issueId === null) {
          return {
            result: errorResult(
              "Error: verdict='confirmed' requires issue_id — the id flag_issue returned for the issue this lead became. Flag the issue first, or resolve the lead as rejected.",
            ),
          };
        }
        const issue = ctx.db
          .select({ filePath: walkthroughIssues.filePath })
          .from(walkthroughIssues)
          .where(
            and(
              eq(walkthroughIssues.id, issueId),
              eq(walkthroughIssues.walkthroughId, ctx.walkthroughId),
            ),
          )
          .get();
        if (!issue) {
          // Withdrawn by the relevance judgment behind flag_issue: the agent
          // did confirm the lead, and the record says so, with no issue to link.
          if (!ctx.jev.issueRetracted(issueId)) {
            return {
              result: errorResult(
                `Error: issue_id '${issueId}' does not match any flagged issue for this walkthrough. Pass the id from flag_issue's result.`,
              ),
            };
          }
          withdrawn = true;
        } else if (issue.filePath !== lead.filePath) {
          return {
            result: errorResult(
              `Error: lead ${lead.id} is in ${lead.filePath}, but issue '${issueId}' is ${issue.filePath === null ? "PR-wide" : `in ${issue.filePath}`}. Confirm a lead with the issue raised on its own file, or resolve it as rejected.`,
            ),
          };
        } else {
          linkedIssueId = issueId;
        }
      } else if (reason.length === 0) {
        return {
          result: errorResult(
            "Error: verdict='rejected' requires reason — one sentence naming what in the code answers the lead.",
          ),
        };
      }

      ctx.db
        .update(walkthroughLeads)
        .set({
          verdict: input.verdict,
          issueId: linkedIssueId,
          reason: input.verdict === "rejected" ? reason : null,
          resolvedAt: new Date().toISOString(),
        })
        .where(
          and(
            eq(walkthroughLeads.walkthroughId, ctx.walkthroughId),
            eq(walkthroughLeads.leadKey, lead.id),
          ),
        )
        .run();
      const left = findUnresolvedLeads(ctx.db, ctx.walkthroughId).length;
      const tail =
        left === 0 ? "Every lead has a verdict." : `${left} lead(s) still need a verdict.`;
      const resolved = readWalkthroughLead(ctx.db, ctx.walkthroughId, lead.id);
      return {
        result: okResult(
          withdrawn
            ? `Lead ${lead.id} recorded as confirmed. The issue you raised for it was withdrawn after you flagged it, so it stays unlinked — not an error, nothing to retry. ${tail}`
            : `Lead ${lead.id} recorded as ${input.verdict}. ${tail}`,
        ),
        ...(resolved ? { event: resolved } : {}),
      };
    },
  );
  if (event) ctx.emit({ type: "lead", data: event });
  return result;
};
