// ─── stack-brief-tools/spec ──────────────────────────────────────────────────
//
// MCP tool surface for the stack brief: the agent-written arc of a GitHub PR
// stack. Two phases, in order:
//
//   Phase L — one `set_layer_role(position, role, review_focus, chapter,
//             builds_on)` per layer, upserted on (brief_id, position). The
//             phase advances to 'L' when every layer in the snapshot has a row.
//   Phase R — one `set_arc(arc_markdown, review_order)`. Requires every
//             layer's role.
//
// `get_stack_brief_state` (call first, every run) and `get_stack_layers` are
// read-only. `complete_stack_brief` only validates; the orchestrator
// (`StackBriefJobs`) flips `status`, never the agent (CLAUDE.md invariant 11).

import { z } from "zod";
import type { Db } from "../../../db";
import { parseJsonWith, stackEntryStatusSchema } from "../../../services/stacks/snapshot";
import type { ToolSpec as GatewayToolSpec, McpToolResult } from "../mcp-tool-gateway";

// ── Snapshot: the stack the agent was handed ────────────────────────────────

const snapshotLayerSchema = z.object({
  position: z.number().int(),
  number: z.number().int(),
  title: z.string(),
  headSha: z.string().nullable(),
  status: stackEntryStatusSchema,
  /** Revv's row for the PR, null when Revv doesn't track it. */
  prId: z.string().nullable(),
  additions: z.number().int(),
  deletions: z.number().int(),
  changedFiles: z.number().int(),
  /** The PR description, truncated at capture. */
  body: z.string().nullable(),
});

/**
 * Written once by the orchestrator into `stack_briefs.stack_snapshot`, so a
 * resume briefs the same stack. `layers` holds the open layers only, bottom
 * first: those are the ones the brief covers. Merged layers ride along in
 * `merged` as context.
 */
export const stackBriefSnapshotSchema = z.object({
  stackNumber: z.number().int(),
  baseRefName: z.string(),
  layers: z.array(snapshotLayerSchema),
  merged: z.array(z.object({ number: z.number().int(), title: z.string() })),
  capturedAt: z.string(),
});

export type StackBriefSnapshot = z.infer<typeof stackBriefSnapshotSchema>;

export function parseStackBriefSnapshot(json: string): StackBriefSnapshot | null {
  return parseJsonWith(stackBriefSnapshotSchema, json);
}

// ── Handler execution context ────────────────────────────────────────────────

export interface StackBriefToolContext {
  readonly db: Db;
  /** The brief row every call reads and writes. */
  readonly briefId: string;
  /** Fired when `complete_stack_brief` validates; the orchestrator then flips status. */
  readonly onCompleted: () => void;
  /**
   * Tool names that reached a handler this run, recorded by the HTTP route.
   * Ephemeral; the runner reads it to tell "never engaged" from "stopped early".
   */
  readonly toolCalls?: Set<string>;
}

export interface StackBriefToolResult extends McpToolResult {
  [k: string]: unknown;
}

export type StackBriefToolHandler<TInput> = (
  ctx: StackBriefToolContext,
  input: TInput,
) => Promise<StackBriefToolResult>;

export type StackBriefToolSpecRecord = GatewayToolSpec<StackBriefToolContext, StackBriefToolResult>;

// ── Limits ───────────────────────────────────────────────────────────────────

/** `role` and `review_focus` are one line each. */
export const LAYER_LINE_MAX_CHARS = 240;
/** The arc is a short paragraph: two or three sentences. */
export const ARC_MAX_CHARS = 600;
/** A chapter name is a label, not a sentence. */
export const CHAPTER_MAX_CHARS = 24;
/** What a layer takes from one it builds on, as a phrase. */
export const USES_MAX_CHARS = 120;
/** The few lower layers that matter most; the rest is the stack's order. */
export const BUILDS_ON_MAX = 3;

// ── Tool input schemas ───────────────────────────────────────────────────────

export const getStackBriefStateSchema = z.object({});

export const getStackLayersSchema = z.object({});

export const setLayerRoleSchema = z.object({
  position: z.coerce
    .number()
    .int()
    .describe("The layer's `position` from get_stack_brief_state.snapshot.layers."),
  role: z
    .string()
    .min(1)
    .describe(
      `One line, at most ${LAYER_LINE_MAX_CHARS} characters: what this layer contributes to the stack. Plain prose; backtick code spans allowed.`,
    ),
  review_focus: z
    .string()
    .min(1)
    .describe(
      `One line, at most ${LAYER_LINE_MAX_CHARS} characters: where a reviewer of this layer should look hardest. Name the file, function or decision.`,
    ),
  chapter: z
    .string()
    .min(1)
    .describe(
      `One to three words, at most ${CHAPTER_MAX_CHARS} characters: the phase of the stack this layer belongs to ("Roles", "Storage", "Admin UI"). Consecutive layers doing one job share a chapter; a stack has a handful, not one per layer.`,
    ),
  builds_on: z
    .array(
      z.object({
        number: z.coerce.number().int().describe("A lower layer's PR number (open or merged)."),
        uses: z
          .string()
          .min(1)
          .describe(
            `A phrase, at most ${USES_MAX_CHARS} characters, naming what this layer takes from it: "the \`ApiCredential\` table", "the explicit role model".`,
          ),
      }),
    )
    .default([])
    .describe(
      `At most ${BUILDS_ON_MAX} lower layers this layer directly depends on: it calls, imports, migrates or extends what they added. Not every layer below; empty for the base layer or one that stands alone.`,
    ),
});

export const setArcSchema = z.object({
  arc_markdown: z
    .string()
    .min(1)
    .describe(
      `Two or three sentences, at most ${ARC_MAX_CHARS} characters: what the stack achieves end to end, told through its chapters. Markdown inline only (backticks, emphasis). Cite at most two layers as #N; never walk the layers one by one.`,
    ),
  review_order: z
    .array(z.coerce.number().int())
    .describe(
      "Every open layer's PR number, each exactly once, in the order to review them. Bottom-up unless the arc says why not.",
    ),
});

export const completeStackBriefSchema = z.object({});

export type GetStackBriefStateInput = z.infer<typeof getStackBriefStateSchema>;
export type GetStackLayersInput = z.infer<typeof getStackLayersSchema>;
export type SetLayerRoleInput = z.infer<typeof setLayerRoleSchema>;
export type SetArcInput = z.infer<typeof setArcSchema>;
export type CompleteStackBriefInput = z.infer<typeof completeStackBriefSchema>;
