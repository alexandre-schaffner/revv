import { execFile } from "node:child_process";

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

export interface ShellOptions {
  cwd?: string;
  timeout?: number;
  env?: Record<string, string>;
}

/**
 * Run a command and return its output.
 * Uses execFile — no shell interpolation.
 * CWD is per-call, never mutates process.cwd().
 */
export function exec(
  bin: string,
  args: string[] = [],
  options?: ShellOptions,
): Promise<ShellResult> {
  const start = performance.now();
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      {
        cwd: options?.cwd,
        timeout: options?.timeout ?? 30_000,
        maxBuffer: 1024 * 1024,
        env: options?.env ? { ...process.env, ...options.env } : undefined,
      },
      (error, stdout, stderr) => {
        const durationMs = Math.round(performance.now() - start);
        resolve({
          stdout: stdout?.toString() ?? "",
          stderr: stderr?.toString() ?? "",
          exitCode:
            error && "code" in error
              ? (error.code as number)
              : error
                ? 1
                : 0,
          durationMs,
        });
      },
    );
  });
}

/** Run a command, return stdout lines (trimmed, empty lines filtered). */
export async function execLines(
  bin: string,
  args: string[] = [],
  options?: ShellOptions,
): Promise<string[]> {
  const result = await exec(bin, args, options);
  if (result.exitCode !== 0) return [];
  return result.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}
