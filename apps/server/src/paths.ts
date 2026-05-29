import { homedir, platform } from "node:os";
import { join } from "node:path";
import { serverEnv } from "./config";

/**
 * OS-appropriate per-user application data directory for Revv.
 *
 *   macOS:   ~/Library/Application Support/Revv
 *   Windows: %APPDATA%/Revv
 *   Linux:   $XDG_DATA_HOME/revv  (or ~/.local/share/revv)
 *
 * Dev builds use a distinct directory (`Revv Dev` / `revv-dev`) so a developer
 * machine running both channels keeps secrets and keys separate. This is the
 * shared resolution used by `auth.ts` (signing key) and `SecretStore`
 * (encrypted-file fallback).
 */
export function appDataDir(): string {
  const home = homedir();
  const plat = platform();
  const appDir = serverEnv.channel === "dev" ? "Revv Dev" : "Revv";
  const xdgDir = serverEnv.channel === "dev" ? "revv-dev" : "revv";
  if (plat === "darwin") {
    return join(home, "Library", "Application Support", appDir);
  }
  if (plat === "win32") {
    const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
    return join(appData, appDir);
  }
  const xdg = process.env.XDG_DATA_HOME ?? join(home, ".local", "share");
  return join(xdg, xdgDir);
}

/**
 * OS keyring service name under which GitHub tokens are stored. Channel-keyed
 * so dev and prod installs on the same machine don't collide on keychain
 * entries.
 */
export function keyringServiceName(): string {
  return serverEnv.channel === "dev" ? "Revv Dev" : "Revv";
}
