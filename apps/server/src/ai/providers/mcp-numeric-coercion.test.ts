// Regression: some ACP agents (opencode) deliver tool-call arguments as
// strings — `semantic_step_index: "0"` rather than `0`. A plain `z.number()`
// rejects that with "expected number, received string", which stalled the
// entire walkthrough pipeline on its first `add_semantic_step` call (the agent
// burned its retries and the run failed). Every numeric field on the agent tool
// surfaces must coerce string→number at the wire boundary while still enforcing
// int/range constraints. This locks that in for all three agent MCP surfaces.

import { describe, expect, it } from "bun:test";
import { z } from "zod";
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

// Walk the zod tree, returning the path tokens to every leaf whose
// unwrapped core is a ZodNumber. Optional / Nullable / Default wrappers
// are stripped so nested numeric fields are reached:
//   block_refs[].semantic_step_index, citations[].start_line,
//   initial_block.code.start_line, …
type PathToken = string | number;
type NumericPath = ReadonlyArray<PathToken>;

// Zod wraps .optional() / .nullable() / .default() in Def-holding shells.
// Each def exposes its inner type at `_zod.def.innerType`; peel until stable.
function unwrap(t: z.ZodType): z.ZodType {
  let cur: z.ZodType = t;
  for (let i = 0; i < 16; i++) {
    const def = (cur as { _zod?: { def?: { innerType?: z.ZodType } } })._zod?.def;
    if (!def?.innerType) break;
    cur = def.innerType;
  }
  return cur;
}

function collectNumericPaths(t: z.ZodType, basePath: NumericPath = []): ReadonlyArray<NumericPath> {
  const u = unwrap(t);
  if (u instanceof z.ZodNumber) return [basePath];
  if (u instanceof z.ZodObject) {
    const shape = u.shape as Record<string, z.ZodType>;
    const out: NumericPath[] = [];
    for (const key of Object.keys(shape)) {
      const child = shape[key];
      if (child) out.push(...collectNumericPaths(child, [...basePath, key]));
    }
    return out;
  }
  if (u instanceof z.ZodArray) {
    return collectNumericPaths(u.element as z.ZodType, [...basePath, 0]);
  }
  return [];
}

// Materialise the containers along `path` on `root`, then drop `value` at the
// leaf. Sibling fields stay omitted; we only need the probe path populated.
function setPath(
  root: Record<string, unknown>,
  path: NumericPath,
  value: unknown,
): Record<string, unknown> {
  if (path.length === 0) return root;
  let cur: Record<string, unknown> = root;
  for (let i = 0; i < path.length - 1; i++) {
    const tok = path[i];
    const nextTok = path[i + 1];
    if (tok === undefined || nextTok === undefined) return root;
    if (cur[tok] == null) cur[tok] = typeof nextTok === "number" ? [] : {};
    cur = cur[tok] as Record<string, unknown>;
  }
  const last = path[path.length - 1];
  if (last !== undefined) cur[last] = value;
  return root;
}

function pathsEqual(a: ReadonlyArray<unknown>, b: ReadonlyArray<unknown>): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

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

  it("no numeric field at any depth rejects a numeric string as a non-number", () => {
    // Recurse into the schema rather than probing only top-level keys, so
    // nested numeric paths are covered: block_refs[].semantic_step_index,
    // block_refs[].step_index, citations[].start_line, citations[].end_line,
    // initial_block.code.start_line, content.code.end_line, … For each
    // numeric leaf, populate just its path on an empty payload and parse.
    // The sibling fields stay omitted (they surface their own errors, which
    // we ignore); the only assertion is that THE probed path does not raise
    // an "expected number, received string" invalid_type error.
    for (const { label, specs } of SURFACES) {
      for (const spec of specs) {
        for (const path of collectNumericPaths(spec.inputSchema)) {
          if (path.length === 0) continue;
          const result = spec.inputSchema.safeParse(setPath({}, path, "1") as object);
          if (result.success) continue;
          const rejectedAsNonNumber = result.error.issues.some(
            (i) =>
              i.code === "invalid_type" &&
              (i as { expected?: string }).expected === "number" &&
              pathsEqual(i.path, path),
          );
          expect(
            rejectedAsNonNumber,
            `${label}.${spec.name}.${path.join(".")} rejected "1" as a non-number — nested numeric fields must coerce`,
          ).toBe(false);
        }
      }
    }
  });
});
