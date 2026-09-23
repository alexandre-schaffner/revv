import { EXTERNAL_REVIEW_TOOL_SPECS } from "../apps/server/src/ai/providers/external-review-tools";
import { EXTERNAL_AGENT_SCOPES } from "../apps/server/src/services/ExternalIntegrations";

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
if (EXTERNAL_REVIEW_TOOL_SPECS.length !== 11) {
  throw new Error(
    `Expected the reviewed 11-tool external surface, found ${EXTERNAL_REVIEW_TOOL_SPECS.length}. Review authorization before changing this gate.`,
  );
}

console.log(`External agent contract OK (${EXTERNAL_REVIEW_TOOL_SPECS.length} scoped tools).`);
