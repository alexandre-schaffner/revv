#!/usr/bin/env bun
// Audit the GitHub call ledger: what Revv asked GitHub, who asked, and what
// of it was slow or wasted. See docs/github-ledger.md.
//
//   bun run github:audit                     # everything in the dev ledger
//   bun run github:audit --since 2m          # just the last two minutes
//   bun run github:audit --origin conversation --timeline
//   bun run github:audit --file ~/Library/Application\ Support/Revv/github-ledger.prod.jsonl

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { analyze } from "../src/observability/github-ledger/analyze";
import { githubLedgerPath, ledgerBesideDb } from "../src/observability/github-ledger/config";
import { formatReport, formatTimeline } from "../src/observability/github-ledger/format";
import type { GitHubCall } from "../src/observability/github-ledger/record";
import { selectCalls } from "../src/observability/github-ledger/select";

const { values } = parseArgs({
  options: {
    file: { type: "string" },
    since: { type: "string" },
    origin: { type: "string" },
    timeline: { type: "boolean", default: false },
    findings: { type: "string" },
    json: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (values.help) {
  console.log(`usage: bun run github:audit [--file path] [--since 90s|5m|ISO] [--origin text]
                            [--timeline] [--findings N] [--json]`);
  process.exit(0);
}

const serverDir = resolve(import.meta.dir, "..");
const candidates = [
  values.file,
  githubLedgerPath() ?? undefined,
  // Where `make dev` and the installed app write theirs.
  ledgerBesideDb("dev", join(serverDir, "revv-dev.db")),
  ledgerBesideDb("prod", ""),
].filter((p): p is string => typeof p === "string");
const file = candidates.find((p) => existsSync(p));
if (!file) {
  console.error(
    `No ledger found (looked at ${candidates.join(", ")}).\nRun the server with \`make dev\` (or REVV_GITHUB_LEDGER=1) and use the app first.`,
  );
  process.exit(1);
}

const calls: GitHubCall[] = [];
for (const path of [`${file}.1`, file]) {
  if (!existsSync(path)) continue;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      calls.push(JSON.parse(line) as GitHubCall);
    } catch {
      // A line cut off by a crash mid-write.
    }
  }
}

const selected = selectCalls(calls, {
  since: values.since ?? null,
  origin: values.origin ?? null,
});
const report = analyze(selected);

if (values.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`ledger: ${file}\n`);
  console.log(formatReport(report, values.findings ? { findings: Number(values.findings) } : {}));
  if (values.timeline) console.log(`\nTIMELINE\n${formatTimeline(selected)}`);
}
