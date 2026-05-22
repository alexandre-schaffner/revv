import { execFile } from "node:child_process";

export interface ShellResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Run a command and return its output.
 * First arg is the binary, rest are args — no shell interpolation.
 */
export function exec(
  cmd: string,
  args: string[] = [],
  options?: { cwd?: string; timeout?: number },
): Promise<ShellResult> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        cwd: options?.cwd,
        timeout: options?.timeout ?? 10_000,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        resolve({
          stdout: stdout?.toString() ?? "",
          stderr: stderr?.toString() ?? "",
          code: error && "code" in error ? (error.code as number) : error ? 1 : 0,
        });
      },
    );
  });
}
