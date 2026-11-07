// The orchestrator records each lead row before the prompt goes out;
// resolve_lead writes only its verdict columns (CLAUDE.md invariant 2).

import type { WalkthroughLead } from "@revv/shared";
import { and, eq } from "drizzle-orm";
import { walkthroughIssues } from "../../../db/schema/walkthrough-issues";
import { walkthroughLeads } from "../../../db/schema/walkthrough-leads";
import { findUnresolvedLeads, readWalkthroughLead } from "../../../services/walkthrough-leads";
import { decodePlainText } from "../agent-text";
import { fail, ok } from "../mcp-tool-gateway";
import { openForWrite } from "./phases";
import type { ResolveLeadInput, WalkthroughToolHandler, WalkthroughToolResult } from "./spec";

export const resolveLeadHandler: WalkthroughToolHandler<ResolveLeadInput> = async (ctx, input) => {
  const reason = input.reason ? decodePlainText(input.reason).trim() : "";
  const issueId = input.issue_id?.trim() || null;

  const { result, event } = ctx.db.transaction(
    (): {
      result: WalkthroughToolResult;
      event?: WalkthroughLead;
    } => {
      const open = openForWrite(ctx.db, ctx.walkthroughId, "resolve_lead");
      if ("refusal" in open) return { result: open.refusal };
      const lead = readWalkthroughLead(ctx.db, ctx.walkthroughId, input.lead_id);
      if (!lead) {
        return {
          result: fail(
            `Error: lead_id '${input.lead_id}' is not one of this walkthrough's first-pass leads. Use an id from the prompt's First-pass leads (e.g. \`L1\`); call get_walkthrough_state to list them.`,
          ),
        };
      }

      let linkedIssueId: string | null = null;
      let withdrawn = false;
      if (input.verdict === "confirmed") {
        if (issueId === null) {
          return {
            result: fail(
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
              result: fail(
                `Error: issue_id '${issueId}' does not match any flagged issue for this walkthrough. Pass the id from flag_issue's result.`,
              ),
            };
          }
          withdrawn = true;
        } else if (issue.filePath !== lead.filePath) {
          return {
            result: fail(
              `Error: lead ${lead.id} is in ${lead.filePath}, but issue '${issueId}' is ${issue.filePath === null ? "PR-wide" : `in ${issue.filePath}`}. Confirm a lead with the issue raised on its own file, or resolve it as rejected.`,
            ),
          };
        } else {
          linkedIssueId = issueId;
        }
      } else if (reason.length === 0) {
        return {
          result: fail(
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
        result: ok(
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
