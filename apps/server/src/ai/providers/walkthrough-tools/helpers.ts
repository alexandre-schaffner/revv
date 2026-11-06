import { eq } from "drizzle-orm";
import type { Db } from "../../../db";
import { walkthroughs } from "../../../db/schema/walkthroughs";
import type { WalkthroughToolResult } from "./spec";

export function errorResult(text: string): WalkthroughToolResult {
  return { content: [{ type: "text" as const, text }], isError: true };
}

export function okResult(text: string): WalkthroughToolResult {
  return { content: [{ type: "text" as const, text }] };
}

/**
 * Some agents send a single-field markdown payload JSON-wrapped —
 * `{markdown: '{"markdown": "…"}'}` — and the braces would leak into the UI.
 * Unwraps only a JSON object whose one string field is `expectedKey`, so prose
 * that merely starts with `{` passes through.
 */
export function unwrapJsonWrappedString(value: string, expectedKey: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return value;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return value;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return value;
  }
  const inner = (parsed as Record<string, unknown>)[expectedKey];
  if (typeof inner !== "string") return value;
  return inner;
}

export function loadWalkthroughRow(
  db: Db,
  walkthroughId: string,
): typeof walkthroughs.$inferSelect | null {
  return db.select().from(walkthroughs).where(eq(walkthroughs.id, walkthroughId)).get() ?? null;
}
