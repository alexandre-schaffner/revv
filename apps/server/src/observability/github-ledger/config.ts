import { dirname, join, resolve } from "node:path";
import type { AppChannel } from "@revv/shared";
import { serverEnv } from "../../config";
import { appDataDir } from "../../paths";

/**
 * Where the GitHub call ledger goes, or null when it's off. On for the dev
 * channel, off in prod unless `REVV_GITHUB_LEDGER` says otherwise:
 * `0` turns it off, `1` turns it on beside the DB, a path puts the file there.
 */
export function githubLedgerPath(): string | null {
  const setting = process.env.REVV_GITHUB_LEDGER?.trim() ?? "";
  if (setting === "0") return null;
  if (setting === "" && serverEnv.channel !== "dev") return null;
  if (setting !== "" && setting !== "1") return resolve(setting);
  return ledgerBesideDb(serverEnv.channel, serverEnv.dbPath);
}

/**
 * The ledger a server on `channel` writes beside its DB at `dbPath` — empty
 * meaning the default DB location in the channel's app-data dir.
 */
export function ledgerBesideDb(channel: AppChannel, dbPath: string): string {
  const dir = dbPath ? dirname(resolve(dbPath)) : appDataDir(channel);
  return join(dir, `github-ledger.${channel}.jsonl`);
}
