import type { ActivityKind } from "@revv/shared";
import type { z } from "zod";
import type { TurnMcpServer } from "../acp/run-turn";

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

/** Plan mode and scoped callers may only see what a tool declares it reads. */
export type ToolAccess = "read" | "write";

type ToolSchema = z.ZodObject<z.ZodRawShape>;

/**
 * One MCP tool, declared once: its wire contract, what it may touch, what a
 * live feed shows while it runs, and its handler. `inputSchema` parses raw wire
 * data at the boundary; the handler only receives the parsed value.
 */
export interface ToolDeclaration<Ctx, S extends ToolSchema, Result extends McpToolResult> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: S;
  readonly access: ToolAccess;
  readonly activity?: {
    readonly kind: ActivityKind;
    readonly summary: string | ((input: z.output<S>) => string);
  };
  readonly handler: (ctx: Ctx, input: z.output<S>) => Promise<Result>;
}

/** A declared tool as a surface lists it, its input type erased. */
export interface ToolSpec<Ctx, Result extends McpToolResult = McpToolResult> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: ToolSchema;
  readonly access: ToolAccess;
  readonly activity?: {
    readonly kind: ActivityKind;
    readonly summary: string | ((input: never) => string);
  };
  handler(ctx: Ctx, input: Record<string, unknown>): Promise<Result>;
}

/**
 * Ties a tool's handler (and activity summary) to its schema's parsed type,
 * which the erased {@link ToolSpec} can no longer check.
 */
export function defineTool<Ctx, Result extends McpToolResult = McpToolResult>() {
  return <S extends ToolSchema>(
    declaration: ToolDeclaration<Ctx, S, Result>,
  ): ToolSpec<Ctx, Result> => declaration as unknown as ToolSpec<Ctx, Result>;
}

/** What a live feed shows for a call of `spec`, or null when it declares nothing. */
export function toolCallActivity(
  spec: ToolSpec<unknown, McpToolResult>,
  input: Record<string, unknown>,
): {
  readonly activityKind: ActivityKind;
  readonly toolName: string;
  readonly summary: string;
} | null {
  if (!spec.activity) return null;
  const { kind, summary } = spec.activity;
  return {
    activityKind: kind,
    toolName: spec.name,
    summary: typeof summary === "string" ? summary : summary(input as never),
  };
}

/** One MCP surface: the server name agents see, where Revv serves it, and its tools. */
export interface ToolSpecBundle<Ctx, Result extends McpToolResult = McpToolResult> {
  readonly name: string;
  readonly version: string;
  /** The HTTP path `routes/mcp/` mounts it at. */
  readonly route: string;
  readonly specs: ReadonlyArray<ToolSpec<Ctx, Result>>;
}

/**
 * The endpoint handed to one run's agent. The server name carries `runId` so
 * concurrent runs on one warm agent don't collide.
 */
export function turnMcpServer(
  bundle: ToolSpecBundle<never, McpToolResult>,
  runId: string,
  token: string,
  required: boolean,
): TurnMcpServer {
  return { route: bundle.route, name: `${bundle.name}-${runId}`, token, required };
}
