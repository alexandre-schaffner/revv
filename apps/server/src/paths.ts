import { homedir } from "node:os";
import { join } from "node:path";
import { serverEnv } from "./config";

/**
 * Per-user application data directory for Revv (macOS-only):
 *
 *   ~/Library/Application Support/Revv
 *
 * Dev builds use a distinct directory (`Revv Dev`) so a developer machine
 * running both channels keeps secrets and keys separate. This is the shared
 * resolution used by `auth.ts` (signing key) and `SecretStore`
 * (encrypted-file fallback).
 */
export function appDataDir(): string {
  const home = homedir();
  const appDir = serverEnv.channel === "dev" ? "Revv Dev" : "Revv";
  return join(home, "Library", "Application Support", appDir);
}

/**
 * OS keyring service name under which GitHub tokens are stored. Channel-keyed
 * so dev and prod installs on the same machine don't collide on keychain
 * entries.
 */
export function keyringServiceName(): string {
  return serverEnv.channel === "dev" ? "Revv Dev" : "Revv";
}
