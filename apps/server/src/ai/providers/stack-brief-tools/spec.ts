import type { StackEntryStatus } from "@revv/shared";
import { z } from "zod";
import type { Db } from "../../../db";
import type { ToolSpec as GatewayToolSpec, McpToolResult } from "../mcp-tool-gateway";

interface StackBriefSnapshotLayer {
  readonly position: number;
  readonly number: number;
  readonly title: string;
  readonly headSha: string | null;
  readonly status: StackEntryStatus;
  readonly prId: string | null;
  readonly additions: number;
  readonly deletions: number;
  readonly changedFiles: number;
  readonly body: string | null;
}

export interface StackBriefSnapshot {
  readonly stackNumber: number;
  readonly baseRefName: string;
  readonly layers: ReadonlyArray<StackBriefSnapshotLayer>;
  readonly merged: ReadonlyArray<{ readonly number: number; readonly title: string }>;
  readonly capturedAt: string;
}

export interface StackBriefToolContext {
  readonly db: Db;
  readonly briefId: string;
  readonly onCompleted: () => void;
  /** A tool call reached the route, before its handler runs. */
  readonly onToolCall: (toolName: string) => void;
}

export interface StackBriefToolResult extends McpToolResult {
  [k: string]: unknown;
}

export type StackBriefToolHandler<TInput> = (
  ctx: StackBriefToolContext,
  input: TInput,
) => Promise<StackBriefToolResult>;

export type StackBriefToolSpecRecord = GatewayToolSpec<StackBriefToolContext, StackBriefToolResult>;

export const LAYER_LINE_MAX_CHARS = 240;
export const ARC_MAX_CHARS = 600;
export const CHAPTER_MAX_CHARS = 24;
export const USES_MAX_CHARS = 120;
export const BUILDS_ON_MAX = 3;

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
