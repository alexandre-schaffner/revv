// `tools/list` advertises each tool's zod input schema as JSON Schema, and zod
// throws on what it can't represent (a `.transform()`). This keeps that a test
// failure rather than a broken `tools/list` at runtime.

import { describe, expect, it } from "bun:test";
import { CHAT_TOOL_BUNDLE } from "../../ai/providers/chat-mcp-tools";
import { EXTERNAL_REVIEW_TOOL_BUNDLE } from "../../ai/providers/external-review-tools";
import { RECAP_TOOL_BUNDLE } from "../../ai/providers/recap-tools";
import { STACK_BRIEF_TOOL_BUNDLE } from "../../ai/providers/stack-brief-tools";
import { WALKTHROUGH_TOOL_BUNDLE } from "../../ai/providers/walkthrough-tools";

const BUNDLES = [
  CHAT_TOOL_BUNDLE,
  EXTERNAL_REVIEW_TOOL_BUNDLE,
  RECAP_TOOL_BUNDLE,
  STACK_BRIEF_TOOL_BUNDLE,
  WALKTHROUGH_TOOL_BUNDLE,
];

describe("MCP tool input schemas", () => {
  for (const bundle of BUNDLES) {
    for (const spec of bundle.specs) {
      it(`${bundle.name}/${spec.name} converts to JSON Schema`, () => {
        expect(spec.inputSchema.toJSONSchema()).toMatchObject({ type: "object" });
      });
    }
  }
});
