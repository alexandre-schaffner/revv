#!/usr/bin/env bun
// Audit the GitHub call ledger: what Revv asked GitHub, who asked, and what
// of it was slow or wasted. See docs/github-ledger.md.
//
//   bun run github:audit                     # everything in the dev ledger
//   bun run github:audit --since 2m          # just the last two minutes
//   bun run github:audit --origin conversation --timeline
//   bun run github:audit --file ~/Library/Application\ Support/Revv/github-ledger.prod.jsonl

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { analyze } from "../src/observability/github-ledger/analyze";
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
const env = process.env.REVV_GITHUB_LEDGER;
const candidates = [
  values.file,
  env && env !== "1" && env !== "0" ? env : undefined,
  join(serverDir, "github-ledger.dev.jsonl"),
  join(homedir(), "Library/Application Support/Revv/github-ledger.prod.jsonl"),
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
