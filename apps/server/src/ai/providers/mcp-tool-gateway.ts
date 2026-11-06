import type { z } from "zod";

export interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  [k: string]: unknown;
}

export function ok(text: string): McpToolResult {
  return { content: [{ type: "text" as const, text }] };
}

export function fail(text: string): McpToolResult {
  return { content: [{ type: "text" as const, text }], isError: true };
}

/**
 * One MCP tool declaration. `inputSchema` parses raw wire data at the
 * boundary; handlers only receive parsed values.
 */
export interface ToolSpec<Ctx, Result extends McpToolResult = McpToolResult> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodObject<z.ZodRawShape>;
  handler(ctx: Ctx, input: Record<string, unknown>): Promise<Result>;
}

export interface ToolSpecBundle<Ctx, Result extends McpToolResult = McpToolResult> {
  readonly name: string;
  readonly version: string;
  readonly specs: ReadonlyArray<ToolSpec<Ctx, Result>>;
}
