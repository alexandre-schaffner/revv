import { dirname, join, resolve } from "node:path";
import type { AppChannel } from "@revv/shared";
import { serverEnv } from "../../config";
import type { Db } from "../../db";
import { repositories, userSettings } from "../../db/schema";
import { appDataDir } from "../../paths";

export function githubLedgerPath(): string | null {
  const setting = process.env.REVV_GITHUB_LEDGER?.trim() ?? "";
  if (setting === "0") return null;
  if (setting === "" && serverEnv.channel !== "dev") return null;
  if (setting !== "" && setting !== "1") return resolve(setting);
  return ledgerBesideDb(serverEnv.channel, serverEnv.dbPath);
}

export function ledgerBesideDb(channel: AppChannel, dbPath: string): string {
  const dir = dbPath ? dirname(resolve(dbPath)) : appDataDir(channel);
  return join(dir, `github-ledger.${channel}.jsonl`);
}

/** Web hosts of the GitHub Enterprise servers Revv is configured to call. */
export function configuredGitHubHosts(db: Db): string[] {
  const repoHosts = db.selectDistinct({ host: repositories.githubHost }).from(repositories).all();
  const settingsHosts = db.select({ host: userSettings.githubHost }).from(userSettings).all();
  const hosts = [
    serverEnv.githubHost,
    ...repoHosts.map((r) => r.host),
    ...settingsHosts.map((r) => r.host),
  ]
    .map((host) => host.trim().toLowerCase())
    .filter((host) => host !== "" && host !== "github.com");
  return [...new Set(hosts)];
}
