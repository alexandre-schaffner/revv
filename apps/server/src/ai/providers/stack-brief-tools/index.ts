import type { ToolSpecBundle } from "../mcp-tool-gateway";
import {
  completeStackBriefHandler,
  getStackBriefStateHandler,
  getStackLayersHandler,
  setArcHandler,
  setLayerRoleHandler,
  stackBriefCompletionBlocker,
} from "./handlers";
import {
  completeStackBriefSchema,
  getStackBriefStateSchema,
  getStackLayersSchema,
  type StackBriefToolContext,
  type StackBriefToolResult,
  type StackBriefToolSpecRecord,
  setArcSchema,
  setLayerRoleSchema,
} from "./spec";

export type { StackBriefSnapshot, StackBriefToolContext, StackBriefToolResult } from "./spec";
export {
  completeStackBriefHandler,
  getStackBriefStateHandler,
  getStackLayersHandler,
  setArcHandler,
  setLayerRoleHandler,
  stackBriefCompletionBlocker,
};

const STACK_BRIEF_TOOL_SPECS: StackBriefToolSpecRecord[] = [
  {
    name: "get_stack_brief_state",
    description:
      "Read-only. Call FIRST on every run, including resumes. Returns the brief's phase, the stack snapshot (base branch, open layers bottom first with number, title, head and status; merged layers as context), and whatever a prior run already wrote.",
    inputSchema: getStackBriefStateSchema,
    handler: getStackBriefStateHandler,
  },
  {
    name: "get_stack_layers",
    description:
      "Read-only. Per open layer: title, status, description excerpt, +/- counts, changed file paths (when Revv has the diff), and Revv's latest walkthrough of it (takeaway, sentiment excerpt, risk, open issue titles). This is the evidence for every role and the arc.",
    inputSchema: getStackLayersSchema,
    handler: getStackLayersHandler,
  },
  {
    name: "set_layer_role",
    description:
      "Phase L. Atomic idempotent write, keyed on the layer's position: call once per open layer. `role` is one line on what the layer contributes to the stack; `review_focus` is one line on where its reviewer should look hardest; `chapter` is the one-to-three-word phase of the stack it belongs to, shared by consecutive layers doing one job; `builds_on` names at most three lower layers it directly depends on, each with a phrase on what it takes from them. Re-calling with the same position replaces the line.",
    inputSchema: setLayerRoleSchema,
    handler: setLayerRoleHandler,
  },
  {
    name: "set_arc",
    description:
      "Phase R. Atomic write, after every layer has a role (fails otherwise, naming the missing ones). `arc_markdown`: two or three sentences on what the stack achieves end to end, told through its chapters, citing at most two layers as #N. `review_order`: every open layer's PR number exactly once.",
    inputSchema: setArcSchema,
    handler: setArcHandler,
  },
  {
    name: "complete_stack_brief",
    description:
      "Validation gate. Call LAST. Checks that every layer has a role and the arc is written, then hands the brief to the orchestrator to finalize. After it succeeds, stop.",
    inputSchema: completeStackBriefSchema,
    handler: completeStackBriefHandler,
  },
];

export const STACK_BRIEF_TOOL_BUNDLE: ToolSpecBundle<StackBriefToolContext, StackBriefToolResult> =
  {
    name: "revv-stack-brief",
    version: "1.0.0",
    specs: STACK_BRIEF_TOOL_SPECS,
  };

export const STACK_BRIEF_MCP_SERVER = "revv-stack-brief";
