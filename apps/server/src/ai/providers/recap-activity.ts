import type { Activity, ActivityKind } from "@revv/shared";

/** A recap tool call (by its MCP name), as a feed activity. */
export function buildRecapActivity(toolName: string, input: unknown): Activity {
  return {
    activityKind: recapActivityKind(toolName),
    toolName,
    summary: recapActivitySummary(toolName, input),
    ...(input !== undefined ? { payload: input } : {}),
  };
}

function recapActivityKind(toolName: string): ActivityKind {
  switch (toolName) {
    case "get_recap_state":
    case "get_repo_context":
    case "get_pr_diff":
      return "tool.read";
    case "list_open_prs":
      return "tool.ls";
    case "set_lede":
    case "add_pr_entry":
    case "set_theme_summary":
      return "tool.write";
    default:
      return "tool.mcp";
  }
}

function recapActivitySummary(toolName: string, input: unknown): string {
  const obj =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  const prId =
    typeof obj.prId === "string" ? obj.prId : typeof obj.pr_id === "string" ? obj.pr_id : undefined;
  const theme = typeof obj.theme === "string" ? obj.theme : undefined;
  const verb = typeof obj.verb === "string" ? obj.verb : undefined;

  switch (toolName) {
    case "get_recap_state":
      return "Reading recap state";
    case "get_pr_diff":
      return prId ? `Reading PR diff ${prId}` : "Reading PR diff";
    case "list_open_prs":
      return "Listing open pull requests";
    case "get_repo_context":
      return "Reading prior recaps";
    case "set_lede":
      return "Writing lede";
    case "add_pr_entry":
      if (verb && theme) return `Cataloguing PR — ${verb} (${theme})`;
      if (theme) return `Cataloguing PR (${theme})`;
      return prId ? `Cataloguing PR ${prId}` : "Cataloguing PR";
    case "set_theme_summary":
      return theme ? `Writing theme summary (${theme})` : "Writing theme summary";
    case "complete_recap":
      return "Finalizing recap";
    default:
      return `Using ${toolName}`;
  }
}
