import { createServerFn } from "@tanstack/react-start";
import { queryOptions } from "@tanstack/react-query";
import { Value } from "@sinclair/typebox/value";
import type { TSchema } from "@sinclair/typebox";
import { run, enqueueGated } from "./command-log";
import type { ShellResult } from "./shell";
import { getCurrentWorktree } from "./worktree";

// ── Types ────────────────────────────────────────────────

export type Gate = "auto" | "confirm";

export interface CmdOptions<TInput> {
  args?: (input: TInput) => string[];
  parse?: (stdout: string) => unknown;
  gate?: Gate;
  cwd?: "root" | "worktree";
  timeout?: number;
  staleTime?: number;
  refetchInterval?: number;
  invalidates?: string[];
}

// ── Server function ─────────────────────────────────────
// Stateless shell executor — no registry needed.
// Receives the full command spec and returns raw ShellResult.

interface ShellRequest {
  name: string;
  bin: string;
  args: string[];
  cwd: string; // empty string = process.cwd()
  gate: Gate;
}

const executeShell = createServerFn({ method: "POST" })
  .inputValidator((input: ShellRequest) => input)
  .handler(async ({ data }): Promise<ShellResult> => {
    const cwd = data.cwd || process.cwd();

    if (data.gate === "confirm") {
      const { result } = enqueueGated(data.name, data.bin, data.args, cwd);
      return await result;
    }

    const entry = await run(data.name, data.bin, data.args, cwd);
    if (entry.status === "error" || !entry.result) {
      throw new Error(
        entry.result?.stderr ||
          `Command failed: ${data.bin} ${data.args.join(" ")}`,
      );
    }
    return entry.result;
  });

// ── Helpers ──────────────────────────────────────────────

function slugify(command: string): string {
  return command
    .split(/\s+/)
    .filter((part) => !part.startsWith("-"))
    .join("-");
}

// ── Factory ──────────────────────────────────────────────

export function cmd<TOutput, TInput = void>(
  command: string,
  output: TSchema & { static: TOutput },
  options?: CmdOptions<TInput>,
) {
  const parts = command.split(/\s+/);
  const bin = parts[0]!;
  const baseArgs = parts.slice(1);
  const key = slugify(command);
  const gate = options?.gate ?? "auto";
  const cwdStrategy = options?.cwd ?? "root";
  const parse = options?.parse ?? ((s: string) => JSON.parse(s));

  // Client-side caller — builds args, calls server, parses response
  function callServerFn(input?: TInput): Promise<TOutput> {
    const dynamicArgs = options?.args ? options.args(input as TInput) : [];
    const allArgs = [...baseArgs, ...dynamicArgs];
    const worktree = getCurrentWorktree();
    const cwd = cwdStrategy === "worktree" && worktree ? worktree : "";

    return executeShell({
      data: { name: key, bin, args: allArgs, cwd, gate },
    }).then((result) => {
      const parsed = parse(result.stdout);
      return Value.Decode(output, parsed) as TOutput;
    });
  }

  // Query options factory
  function makeQueryOptions(input?: TInput) {
    const queryKey =
      input !== undefined && input !== null ? [key, input] : [key];

    const opts: {
      queryKey: unknown[];
      queryFn: () => Promise<TOutput>;
      staleTime: number;
      refetchInterval?: number;
    } = {
      queryKey,
      queryFn: () => callServerFn(input),
      staleTime: options?.staleTime ?? 0,
    };

    if (options?.refetchInterval !== undefined) {
      opts.refetchInterval = options.refetchInterval;
    }

    return queryOptions(opts);
  }

  // Mutation options factory
  function makeMutationOptions() {
    return {
      mutationKey: [key],
      mutationFn: (input: TInput) => callServerFn(input),
    };
  }

  return {
    key,
    def: { command, bin, baseArgs, gate, cwd: cwdStrategy },
    serverFn: callServerFn,
    queryOptions: makeQueryOptions,
    mutationOptions: makeMutationOptions,
  };
}
