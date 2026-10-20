import { dirname, join, resolve } from "node:path";
import { serverEnv } from "../../config";
import { appDataDir } from "../../paths";

/**
 * Whether to record GitHub calls, and where the JSONL goes. On for the dev
 * channel, off in prod unless `REVV_GITHUB_LEDGER` says otherwise:
 * `0` turns it off, `1` turns it on beside the DB, a path puts the file there.
 */
export function githubLedgerPath(): { enabled: boolean; path: string | null } {
  const setting = process.env.REVV_GITHUB_LEDGER?.trim() ?? "";
  if (setting === "0") return { enabled: false, path: null };
  const enabled = setting !== "" || serverEnv.channel === "dev";
  if (!enabled) return { enabled: false, path: null };
  if (setting !== "" && setting !== "1") return { enabled, path: resolve(setting) };
  const dir = serverEnv.dbPath ? dirname(resolve(serverEnv.dbPath)) : appDataDir();
  return { enabled, path: join(dir, `github-ledger.${serverEnv.channel}.jsonl`) };
}
