// Regression: some ACP agents (opencode) deliver tool-call arguments as
// strings — `semantic_step_index: "0"` rather than `0`. A plain `z.number()`
// rejects that with "expected number, received string", which stalled the
// entire walkthrough pipeline on its first `add_semantic_step` call (the agent
// burned its retries and the run failed). Every numeric field on the agent tool
// surfaces must coerce string→number at the wire boundary while still enforcing
// int/range constraints. This locks that in for all three agent MCP surfaces.

import { describe, expect, it } from "bun:test";
import type { z } from "zod";
import { EDIT_TOOL_SPECS } from "./chat-edit-tools";
import { RECAP_TOOL_BUNDLE } from "./recap-tools";
import { WALKTHROUGH_TOOL_BUNDLE } from "./walkthrough-tools";

interface SchemaSpec {
  readonly name: string;
  readonly inputSchema: z.ZodObject<z.ZodRawShape>;
}

const SURFACES: ReadonlyArray<{ label: string; specs: readonly SchemaSpec[] }> = [
  { label: "walkthrough", specs: WALKTHROUGH_TOOL_BUNDLE.specs },
  { label: "recap", specs: RECAP_TOOL_BUNDLE.specs },
  { label: "chat-edit", specs: EDIT_TOOL_SPECS as unknown as readonly SchemaSpec[] },
];

describe("agent MCP tools coerce string-valued numeric arguments", () => {
  it("add_semantic_step accepts a string semantic_step_index", () => {
    const spec = WALKTHROUGH_TOOL_BUNDLE.specs.find((s) => s.name === "add_semantic_step");
    expect(spec).toBeDefined();
    const parsed = spec?.inputSchema.safeParse({
      semantic_step_index: "0",
      title: "Chapter",
      initial_block: { markdown: { content: "hello" } },
    });
    expect(parsed?.success).toBe(true);
  });

  it("still rejects non-numeric garbage (coercion is not a blanket accept)", () => {
    const spec = WALKTHROUGH_TOOL_BUNDLE.specs.find((s) => s.name === "add_semantic_step");
    const parsed = spec?.inputSchema.safeParse({
      semantic_step_index: "not-a-number",
      title: "Chapter",
      initial_block: { markdown: { content: "hello" } },
    });
    expect(parsed?.success).toBe(false);
  });

  it("no numeric field on any agent tool rejects a numeric string as a non-number", () => {
    for (const { label, specs } of SURFACES) {
      for (const spec of specs) {
        const shape = spec.inputSchema.shape;
        for (const key of Object.keys(shape)) {
          // Probe each top-level field with a numeric string. A field that is
          // numeric-at-heart must coerce, so it must NOT surface an
          // "expected number, received string" error for this key.
          const probe = spec.inputSchema.safeParse({ [key]: "1" });
          if (probe.success) continue;
          const rejectedAsNonNumber = probe.error.issues.some(
            (i) =>
              i.path.length === 1 &&
              i.path[0] === key &&
              i.code === "invalid_type" &&
              (i as { expected?: string }).expected === "number",
          );
          expect(
            rejectedAsNonNumber,
            `${label}.${spec.name}.${key} rejected "1" as a non-number — numeric fields must coerce`,
          ).toBe(false);
        }
      }
    }
  });
});
