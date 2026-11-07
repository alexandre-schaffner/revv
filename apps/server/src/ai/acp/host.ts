// A server launched by launchd or a GUI inherits a sanitized PATH that omits
// where CLIs actually live (nvm, Homebrew on Apple Silicon, npm global
// prefixes, app-managed bin dirs). Every agent probe and spawn therefore runs
// against the user's *login-shell* PATH, merged onto the process PATH, so
// detection matches what the user sees in a terminal. The login-shell lookup
// can take seconds, so it is cached with a short TTL and refreshed in the
// background once stale; only a cold or invalidated cache waits for it.

import { execFile, execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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

export function invalidateUserPath(): void {
  cachedPath = null;
}

let refreshing: Promise<void> | null = null;

/**
 * The PATH every agent probe and spawn uses (see the module header). A stale
 * value is returned as is while a background refresh replaces it.
 */
export function resolveUserPath(): string {
  if (cachedPath) {
    if (Date.now() >= cachedPath.expiresAt) void refreshUserPath();
    return cachedPath.value;
  }
  return storeUserPath(loginShellPathSync());
}

/** Read the login shell's PATH without blocking; boot calls it so no request pays for it. */
export function refreshUserPath(): Promise<void> {
  refreshing ??= loginShellPathAsync()
    .then((login) => void storeUserPath(login))
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

function storeUserPath(login: string | null): string {
  const base = process.env.PATH ?? "";
  const value = Array.from(
    new Set(
      [...installedBinDirs, ...base.split(":"), ...(login?.split(":") ?? [])].filter(Boolean),
    ),
  ).join(":");
  cachedPath = { value, expiresAt: Date.now() + HOST_PROBE_TTL_MS };
  return value;
}

/**
 * How to print the login shell's PATH, or `null` without a usable `$SHELL`.
 * fish stores `$PATH` as a list, so it needs `string join`; POSIX shells get
 * `printf`. `-lic`: login + interactive, so PATH set in either profile or rc
 * is sourced. argv form: a `$SHELL` with spaces or metacharacters must not be
 * re-parsed.
 */
function loginShellCommand(): { shell: string; args: string[] } | null {
  const shell = process.env.SHELL;
  if (!shell) return null;
  const isFish = /(^|\/)fish$/.test(shell);
  return { shell, args: ["-lic", isFish ? "string join : $PATH" : 'printf %s "$PATH"'] };
}

const LOGIN_SHELL_TIMEOUT_MS = 4000;

const nonEmpty = (out: string): string | null => (out.trim().length > 0 ? out.trim() : null);

function loginShellPathSync(): string | null {
  const command = loginShellCommand();
  if (!command) return null;
  try {
    return nonEmpty(
      execFileSync(command.shell, command.args, {
        encoding: "utf-8",
        timeout: LOGIN_SHELL_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "ignore"],
      }),
    );
  } catch {
    return null;
  }
}

async function loginShellPathAsync(): Promise<string | null> {
  const command = loginShellCommand();
  if (!command) return null;
  try {
    const pending = execFileAsync(command.shell, command.args, {
      encoding: "utf-8",
      timeout: LOGIN_SHELL_TIMEOUT_MS,
    });
    pending.child.stdin?.end();
    return nonEmpty((await pending).stdout);
  } catch {
    return null;
  }
}

/** Where `command` would be looked up on `path`, in order. */
function candidatesFor(command: string, path: string): string[] {
  return isAbsolute(command)
    ? [command]
    : path
        .split(delimiter)
        .filter(Boolean)
        .map((dir) => join(dir, command));
}

function isExecutableFile(candidate: string): boolean {
  try {
    accessSync(candidate, constants.X_OK);
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/** Absolute path of `command` on the user's PATH, else null: what `which` answers. */
export function resolveCommandPath(command: string): string | null {
  return candidatesFor(command, resolveUserPath()).find(isExecutableFile) ?? null;
}

export function isCommandOnPath(command: string): boolean {
  return resolveCommandPath(command) !== null;
}

export function executableExists(command: string, path: string): boolean {
  return candidatesFor(command, path).some(isExecutableFile);
}

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

/** Whether `command` exits 0 within 5 seconds. */
export async function commandSucceeds(
  command: string,
  args: readonly string[],
  env: Record<string, string>,
): Promise<boolean> {
  try {
    const pending = execFileAsync(command, [...args], { encoding: "utf-8", timeout: 5000, env });
    pending.child.stdin?.end();
    await pending;
    return true;
  } catch {
    return false;
  }
}
