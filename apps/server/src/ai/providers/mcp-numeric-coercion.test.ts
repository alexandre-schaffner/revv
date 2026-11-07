// Some ACP agents (opencode) deliver tool-call arguments as strings —
// `semantic_step_index: "0"` rather than `0`. A plain `z.number()` rejects that
// and stalls the pipeline on the first numeric call, so every numeric field on
// every agent MCP surface must coerce string→number while still enforcing
// int/range constraints.

import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { EDIT_TOOL_SPECS } from "./chat-edit-tools";
import { EXTERNAL_REVIEW_TOOL_SPECS } from "./external-review-tools";
import { RECAP_TOOL_BUNDLE } from "./recap-tools";
import { WALKTHROUGH_TOOL_BUNDLE } from "./walkthrough-tools";

interface SchemaSpec {
  readonly name: string;
  readonly inputSchema: z.ZodObject<z.ZodRawShape>;
}

const SURFACES: ReadonlyArray<{ label: string; specs: readonly SchemaSpec[] }> = [
  { label: "walkthrough", specs: WALKTHROUGH_TOOL_BUNDLE.specs },
  { label: "recap", specs: RECAP_TOOL_BUNDLE.specs },
  { label: "chat-edit", specs: EDIT_TOOL_SPECS },
  { label: "external", specs: EXTERNAL_REVIEW_TOOL_SPECS },
];

type PathToken = string | number;
type NumericPath = ReadonlyArray<PathToken>;

// Public classes + `.unwrap()` only, never zod's private `_zod.def`: a private
// rename would silently stop the peel and let the "any depth" test pass
// vacuously, while a missing public class throws.
const WRAPPER_CLASSES = [
  z.ZodOptional,
  z.ZodNullable,
  z.ZodDefault,
  z.ZodCatch,
  z.ZodPrefault,
  z.ZodReadonly,
] as const;

function unwrap(t: z.ZodType): z.ZodType {
  let cur: z.ZodType = t;
  for (let i = 0; i < 16; i++) {
    const isWrapper = WRAPPER_CLASSES.some((cls) => cur instanceof cls);
    if (!isWrapper) break;
    cur = (cur as unknown as { unwrap: () => z.ZodType }).unwrap();
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

  it("walker discovers nested numeric paths that require wrapper peeling", () => {
    // A broken peel (a zod upgrade, or a wrapper unwrap() doesn't know) makes
    // the next test pass vacuously; pinning paths that need one fails here.
    const pathsOf = (specs: readonly SchemaSpec[], name: string): Set<string> => {
      const spec = specs.find((s) => s.name === name);
      expect(spec).toBeDefined();
      return spec
        ? new Set(collectNumericPaths(spec.inputSchema).map((p) => p.join(".")))
        : new Set<string>();
    };
    const wt = WALKTHROUGH_TOOL_BUNDLE.specs;
    const ce = EDIT_TOOL_SPECS;

    const addStep = pathsOf(wt, "add_semantic_step");
    expect(addStep.has("initial_block.code.start_line")).toBe(true);
    expect(addStep.has("initial_block.code.end_line")).toBe(true);

    const flagIssue = pathsOf(wt, "flag_issue");
    expect(flagIssue.has("block_refs.0.semantic_step_index")).toBe(true);
    expect(flagIssue.has("block_refs.0.step_index")).toBe(true);

    const rateAxis = pathsOf(wt, "rate_axis");
    expect(rateAxis.has("citations.0.start_line")).toBe(true);
    expect(rateAxis.has("citations.0.end_line")).toBe(true);
    expect(rateAxis.has("block_refs.0.semantic_step_index")).toBe(true);

    const updateRating = pathsOf(ce, "update_rating");
    expect(updateRating.has("citations.0.start_line")).toBe(true);
    expect(updateRating.has("citations.0.end_line")).toBe(true);
    expect(updateRating.has("block_refs.0.semantic_step_index")).toBe(true);
    expect(updateRating.has("block_refs.0.step_index")).toBe(true);

    const updateIssue = pathsOf(ce, "update_issue");
    expect(updateIssue.has("block_refs.0.semantic_step_index")).toBe(true);
    expect(updateIssue.has("block_refs.0.step_index")).toBe(true);
  });

  it("no numeric field at any depth rejects a numeric string as a non-number", () => {
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
