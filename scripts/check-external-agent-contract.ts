import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EXTERNAL_REVIEW_TOOL_SPECS,
  MAX_WAIT_SECONDS,
} from "../apps/server/src/ai/providers/external-review-tools";
import {
  EXTERNAL_AGENT_SCOPES,
  type ExternalAgentScope,
} from "../apps/server/src/services/ExternalIntegrations";

const names = EXTERNAL_REVIEW_TOOL_SPECS.map((spec) => spec.name);
const duplicateNames = names.filter((name, index) => names.indexOf(name) !== index);
const unknownScopes = EXTERNAL_REVIEW_TOOL_SPECS.filter(
  (spec) => !EXTERNAL_AGENT_SCOPES.includes(spec.scope),
);

if (duplicateNames.length > 0) {
  throw new Error(`External MCP tool names must be unique: ${duplicateNames.join(", ")}`);
}
if (unknownScopes.length > 0) {
  throw new Error(
    `External MCP tools have unknown scopes: ${unknownScopes.map((spec) => spec.name).join(", ")}`,
  );
}
// The reviewed external surface. A count would pass a swapped tool or a changed
// scope; this table makes every name and scope change an explicit edit here.
const REVIEWED_SURFACE: Record<string, ExternalAgentScope> = {
  get_review_context: "context:read",
  get_walkthrough_for_edit: "context:read",
  update_overview: "walkthrough:edit",
  update_semantic_step: "walkthrough:edit",
  update_block: "walkthrough:edit",
  update_sentiment: "walkthrough:edit",
  update_rating: "walkthrough:edit",
  update_issue: "walkthrough:edit",
  record_issue_resolution: "issues:resolve",
  reply_to_comment: "comments:write",
  update_comment_status: "comments:write",
  request_walkthrough: "walkthrough:generate",
  wait_for_walkthrough: "context:read",
};
const surfaceDrift = [
  ...EXTERNAL_REVIEW_TOOL_SPECS.filter((spec) => REVIEWED_SURFACE[spec.name] !== spec.scope).map(
    (spec) => `${spec.name} (${spec.scope})`,
  ),
  ...Object.keys(REVIEWED_SURFACE)
    .filter((name) => !names.includes(name))
    .map((name) => `${name} (missing)`),
];
if (surfaceDrift.length > 0) {
  throw new Error(
    `External MCP tools differ from the reviewed surface: ${surfaceDrift.join(", ")}. Review authorization before changing this gate.`,
  );
}

// `wait_for_walkthrough` holds a bridge request open for its whole wait. Read,
// not imported: importing the bridge would start its stdin loop.
const bridgeSource = readFileSync(
  join(import.meta.dir, "../integrations/external-mcp-bridge/revv-mcp.ts"),
  "utf8",
);
const bridgeTimeout = /const REQUEST_TIMEOUT_MS = ([\d_]+);/.exec(bridgeSource)?.[1];
if (bridgeTimeout === undefined) {
  throw new Error("Could not find REQUEST_TIMEOUT_MS in the external MCP bridge.");
}
if (MAX_WAIT_SECONDS * 1000 >= Number(bridgeTimeout.replaceAll("_", ""))) {
  throw new Error(
    `wait_for_walkthrough may wait ${MAX_WAIT_SECONDS}s, at or past the bridge's ${bridgeTimeout}ms request timeout.`,
  );
}

console.log(`External agent contract OK (${EXTERNAL_REVIEW_TOOL_SPECS.length} scoped tools).`);
