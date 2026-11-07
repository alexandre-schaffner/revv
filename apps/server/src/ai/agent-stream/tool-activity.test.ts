import { describe, expect, it } from "bun:test";
import { acpToolName, buildActivity, isExplorationTool } from "./tool-activity";

describe("agent tool table", () => {
  it("names a kind-tagged ACP tool call canonically, and anything else by its title", () => {
    expect(acpToolName("read", "Read src/a.ts")).toBe("Read");
    expect(acpToolName("execute", "git status")).toBe("Bash");
    expect(acpToolName("other", "mcp__revv-recap__set_lede")).toBe("mcp__revv-recap__set_lede");
    expect(acpToolName(undefined, "")).toBe("Tool");
  });

  it("reads opencode's lowercase titles as the canonical tools", () => {
    expect(buildActivity("todowrite", {})).toMatchObject({
      toolName: "TodoWrite",
      activityKind: "tool.todo",
    });
    expect(buildActivity("list", { path: "/repo/src" }, "/repo")).toMatchObject({
      toolName: "LS",
      activityKind: "tool.ls",
      summary: "Listing src",
    });
  });

  it("summarizes with worktree-relative paths", () => {
    const activity = buildActivity("Read", { file_path: "/repo/src/a.ts" }, "/repo", "call-1");
    expect(activity).toEqual({
      activityKind: "tool.read",
      toolName: "Read",
      summary: "Reading src/a.ts",
      payload: { file_path: "src/a.ts" },
      callId: "call-1",
    });
  });

  it("classifies MCP and unknown tools without a summary of their own", () => {
    expect(buildActivity("mcp__revv__get_state", undefined)).toEqual({
      activityKind: "tool.mcp",
      toolName: "mcp__revv__get_state",
      summary: "Using mcp__revv__get_state",
    });
    expect(buildActivity("Set the lede", undefined).activityKind).toBe("tool.other");
  });

  it("shows the agent's exploration tools in the job feeds, not its todo list or MCP calls", () => {
    expect(isExplorationTool("Read")).toBe(true);
    expect(isExplorationTool("bash")).toBe(true);
    expect(isExplorationTool("TodoWrite")).toBe(false);
    expect(isExplorationTool("mcp__revv-recap__set_lede")).toBe(false);
  });
});
