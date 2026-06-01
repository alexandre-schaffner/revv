import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
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

export interface BindInProcessOptions<Ctx> {
  readonly beforeToolCall?: (toolName: string, ctx: Ctx) => void;
}

export function bindInProcess<Ctx, Result extends McpToolResult>(
  bundle: ToolSpecBundle<Ctx, Result>,
  ctx: Ctx,
  options: BindInProcessOptions<Ctx> = {},
): ReturnType<typeof createSdkMcpServer> {
  return createSdkMcpServer({
    name: bundle.name,
    version: bundle.version,
    tools: bundle.specs.map((spec) =>
      tool(
        spec.name,
        spec.description,
        spec.inputSchema.shape,
        async (args: Record<string, unknown>) => {
          options.beforeToolCall?.(spec.name, ctx);
          // Parse raw args against the spec schema before dispatch so the
          // in-process SDK path applies the same coercions/defaults as the
          // HTTP transport (`routes/mcp/utils.ts`). This keeps agent-path
          // parity (CLAUDE.md invariant #13) from depending on SDK-internal
          // validation — defaults that feed idempotency keys must match.
          const parsed = spec.inputSchema.safeParse(args);
          if (!parsed.success) {
            return {
              content: [
                {
                  type: "text",
                  text: `invalid arguments for '${spec.name}': ${parsed.error.message}`,
                },
              ],
              isError: true,
            } satisfies McpToolResult;
          }
          return spec.handler(ctx, parsed.data);
        },
      ),
    ),
  });
}
