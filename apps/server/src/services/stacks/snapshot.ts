// ── Persisted stack snapshots ───────────────────────────────────────────────
//
// `walkthroughs.stack_context` holds the stack a walkthrough's agent saw. The
// column is written by the orchestrator, but it's still text off disk: a row
// that doesn't parse reads as "no stack", never as a crash mid-job.

import type { StackEntryStatus, WalkthroughStackSnapshot } from "@revv/shared";
import { z } from "zod";

export const stackEntryStatusSchema = z.enum([
  "merged",
  "closed",
  "draft",
  "ready",
  "not_ready",
] as const satisfies readonly StackEntryStatus[]);

const walkthroughStackSnapshotSchema = z.object({
  number: z.number(),
  baseRefName: z.string(),
  position: z.number(),
  layers: z.array(
    z.object({
      position: z.number(),
      number: z.number(),
      title: z.string(),
      headSha: z.string().nullable(),
      baseRef: z.string(),
      status: stackEntryStatusSchema,
    }),
  ),
  capturedAt: z.string(),
});

/** Parse JSON a schema owns, or null when it's missing or doesn't parse. */
export function parseJsonWith<T>(schema: z.ZodType<T>, json: string | null): T | null {
  if (!json) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function parseStackSnapshot(json: string | null): WalkthroughStackSnapshot | null {
  return parseJsonWith(walkthroughStackSnapshotSchema, json);
}
