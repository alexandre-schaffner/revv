import type { z } from "zod";

export interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  [k: string]: unknown;
}

/**
 * One MCP tool declaration, shared by the in-process SDK adapter and the HTTP
 * transport. `inputSchema` parses raw wire data at the boundary; handlers only
 * receive parsed values.
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
