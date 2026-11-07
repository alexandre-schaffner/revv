import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EXTERNAL_AGENT_SCOPES } from "@revv/shared";
import {
  EXTERNAL_REVIEW_TOOL_SPECS,
  MAX_WAIT_SECONDS,
} from "../apps/server/src/ai/providers/external-review-tools";

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
if (EXTERNAL_REVIEW_TOOL_SPECS.length !== 13) {
  throw new Error(
    `Expected the reviewed 13-tool external surface, found ${EXTERNAL_REVIEW_TOOL_SPECS.length}. Review authorization before changing this gate.`,
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

// Installed guides name tools; a renamed tool would leave every install
// pointing at one that doesn't exist. Every backticked name the guide starts
// with a tool verb must be a tool.
const guide = readFileSync(
  join(import.meta.dir, "../integrations/external-agent-guides/address-feedback.md"),
  "utf8",
);
const verbs = new Set(names.map((name) => name.split("_")[0]));
const unknownGuideTools = [...guide.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)]
  .map(([, name]) => name ?? "")
  .filter((name) => verbs.has(name.split("_")[0]) && !names.includes(name));
if (unknownGuideTools.length > 0) {
  throw new Error(
    `The external agent guide names tools that don't exist: ${[...new Set(unknownGuideTools)].join(", ")}`,
  );
}

console.log(`External agent contract OK (${EXTERNAL_REVIEW_TOOL_SPECS.length} scoped tools).`);
