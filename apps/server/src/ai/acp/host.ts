// ── Host probing for agent binaries ──────────────────────────────────────────
//
// A server launched by launchd or a GUI inherits a sanitized PATH that omits
// where CLIs actually live (nvm, Homebrew on Apple Silicon, npm global
// prefixes, app-managed bin dirs). Every agent probe and spawn therefore runs
// against the user's *login-shell* PATH, merged onto the process PATH, so
// detection matches what the user sees in a terminal. The login-shell lookup is
// expensive, so it is cached with a short TTL; `which` against it is cheap.

import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

/** TTL for the cached login-shell PATH (and the agents' cached auth probes). */
export const HOST_PROBE_TTL_MS = 5 * 60 * 1000;

let cachedPath: { value: string; expiresAt: number } | null = null;

/** Directories an in-app agent install wrote to, searched before the user's PATH. */
const installedBinDirs: string[] = [];

/**
 * Put the directories an agent's official installer writes to on the agent
 * PATH, so the next probe finds the binary before the user's shell config is
 * re-sourced. Drops the cached PATH.
 */
export function addInstalledBinDirs(dirs: readonly string[]): void {
  const added = dirs.filter((dir) => existsSync(dir) && !installedBinDirs.includes(dir));
  installedBinDirs.unshift(...added);
  cachedPath = null;
}

/** Drop the cached PATH so the next probe re-reads the shell and filesystem. */
export function invalidateUserPath(): void {
  cachedPath = null;
}

/** The PATH every agent probe and spawn uses (see the module header). */
export function resolveUserPath(): string {
  if (cachedPath && Date.now() < cachedPath.expiresAt) return cachedPath.value;
  const base = process.env.PATH ?? "";
  const login = loginShellPath();
  const value = Array.from(
    new Set(
      [...installedBinDirs, ...base.split(":"), ...(login?.split(":") ?? [])].filter(Boolean),
    ),
  ).join(":");
  cachedPath = { value, expiresAt: Date.now() + HOST_PROBE_TTL_MS };
  return value;
}

/**
 * The login shell's PATH, or `null` without a usable `$SHELL`. fish stores
 * `$PATH` as a list, so it needs `string join`; POSIX shells get `printf`.
 */
function loginShellPath(): string | null {
  const shell = process.env.SHELL;
  if (!shell) return null;
  const isFish = /(^|\/)fish$/.test(shell);
  const inner = isFish ? "string join : $PATH" : 'printf %s "$PATH"';
  try {
    // `-lic`: login + interactive, so PATH set in either profile or rc is sourced.
    // argv form: a `$SHELL` with spaces or metacharacters must not be re-parsed.
    const out = execFileSync(shell, ["-lic", inner], {
      encoding: "utf-8",
      timeout: 4000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/** Absolute path of `command` on the user's PATH, else null. */
export function resolveCommandPath(command: string): string | null {
  try {
    const out = execFileSync("which", [command], {
      encoding: "utf-8",
      timeout: 3000,
      env: { ...process.env, PATH: resolveUserPath() },
    }).trim();
    return out.length > 0 ? (out.split("\n")[0] ?? null) : null;
  } catch {
    return null;
  }
}

export function isCommandOnPath(command: string): boolean {
  return resolveCommandPath(command) !== null;
}

/** Whether `command` is an executable file, absolute or found on `path`. */
export function executableExists(command: string, path: string): boolean {
  const candidates = isAbsolute(command)
    ? [command]
    : path
        .split(delimiter)
        .filter(Boolean)
        .map((dir) => join(dir, command));

  return candidates.some((candidate) => {
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/** The inherited environment with undefined entries dropped and PATH widened. */
export function hostEnv(
  inherited: Readonly<Record<string, string | undefined>> = process.env,
  path: string = resolveUserPath(),
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (value !== undefined) env[key] = value;
  }
  env.PATH = path;
  return env;
}

/** Run a status command; true when it exits 0 within 5 s. */
export function commandSucceeds(
  command: string,
  args: readonly string[],
  env: Record<string, string>,
): boolean {
  try {
    execFileSync(command, args, {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
      env,
    });
    return true;
  } catch {
    return false;
  }
}
