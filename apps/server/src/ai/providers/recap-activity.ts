import type { Activity, ActivityKind } from "@revv/shared";

export function buildRecapActivity(toolName: string, input: unknown): Activity {
  const recapToolName = normalizeRecapToolName(toolName);
  return {
    activityKind: recapActivityKind(recapToolName),
    toolName: recapToolName,
    summary: recapActivitySummary(recapToolName, input),
    ...(input !== undefined ? { payload: input } : {}),
  };
}

export function normalizeRecapToolName(toolName: string): string {
  const known = [
    "get_recap_state",
    "get_pr_diff",
    "list_open_prs",
    "get_repo_context",
    "commit_recap_overview",
    "complete_recap",
    "Bash",
  ];
  return known.find((name) => toolName === name || toolName.endsWith(`_${name}`)) ?? toolName;
}

function recapActivityKind(toolName: string): ActivityKind {
  switch (toolName) {
    case "get_recap_state":
    case "get_repo_context":
    case "get_pr_diff":
      return "tool.read";
    case "list_open_prs":
      return "tool.ls";
    case "commit_recap_overview":
      return "tool.write";
    case "Bash":
      return "tool.bash";
    default:
      return "tool.mcp";
  }
}

function recapActivitySummary(toolName: string, input: unknown): string {
  const obj =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  const prId = typeof obj.prId === "string" ? obj.prId : undefined;

  switch (toolName) {
    case "get_recap_state":
      return "Reading recap state";
    case "get_pr_diff":
      return prId ? `Reading PR diff ${prId}` : "Reading PR diff";
    case "list_open_prs":
      return "Listing open pull requests";
    case "get_repo_context":
      return "Reading prior recaps";
    case "commit_recap_overview":
      return "Saving recap";
    case "complete_recap":
      return "Finalizing recap";
    case "Bash": {
      const cmd = typeof obj.command === "string" ? obj.command : "";
      if (!cmd) return "Running shell command";
      const firstLine = cmd.split("\n")[0] ?? cmd;
      const truncated = firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : firstLine;
      return `$ ${truncated}`;
    }
    default:
      return `Using ${toolName}`;
  }
}
