import { homedir } from "node:os";
import { join } from "node:path";
import type { AppChannel } from "@revv/shared";
import { APP_DATA_DIR_NAME } from "@revv/shared/desktop-contract";
import { serverEnv } from "./config";

/**
 * `~/Library/Application Support/Revv` (macOS-only). Dev builds use
 * `Revv Dev` so a machine running both channels keeps secrets and keys
 * separate.
 */
export function appDataDir(channel: AppChannel = serverEnv.channel): string {
  const home = homedir();
  const appDir = channel === "dev" ? `${APP_DATA_DIR_NAME} Dev` : APP_DATA_DIR_NAME;
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
