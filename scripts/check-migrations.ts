// Guards the invariants that keep a user's database upgradable. Drizzle's
// migrator only runs journal entries whose `when` is newer than the last one
// the database recorded, so an entry that is reordered, renumbered, edited, or
// inserted behind a shipped one is silently skipped on every existing install.
// Nightly builds ship every push to `main`, so anything on `main` has shipped.

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS = "apps/server/src/db/migrations";
const JOURNAL = `${MIGRATIONS}/meta/_journal.json`;

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

const failures: string[] = [];
function check(condition: boolean, message: string): void {
  if (!condition) failures.push(message);
}

function parseJournal(text: string): JournalEntry[] {
  return (JSON.parse(text) as { entries: JournalEntry[] }).entries;
}

const entries = parseJournal(readFileSync(JOURNAL, "utf8"));
const sqlFiles = readdirSync(MIGRATIONS).filter((file) => file.endsWith(".sql"));

// ── Journal shape ────────────────────────────────────────────────────────────
entries.forEach((entry, position) => {
  check(entry.idx === position, `${entry.tag}: idx ${entry.idx} should be ${position}`);
  const previous = entries[position - 1];
  if (previous) {
    check(
      entry.when > previous.when,
      `${entry.tag}: when ${entry.when} must be greater than ${previous.tag}'s ${previous.when}, or upgrading installs skip it`,
    );
  }
});
check(new Set(entries.map((entry) => entry.tag)).size === entries.length, "duplicate journal tags");

// ── Files ↔ journal ──────────────────────────────────────────────────────────
const tags = new Set(entries.map((entry) => entry.tag));
for (const file of sqlFiles) {
  check(tags.has(file.slice(0, -4)), `${file} is not in the journal, so it never runs`);
}
for (const tag of tags) {
  check(sqlFiles.includes(`${tag}.sql`), `journal entry ${tag} has no SQL file`);
}
// Shipped before this check existed; renaming a shipped migration is worse.
const GRANDFATHERED_NUMBERS = new Set(["0140"]);
const prefixes = sqlFiles.map((file) => file.split("_")[0]);
for (const prefix of new Set(prefixes)) {
  if (prefix === undefined || GRANDFATHERED_NUMBERS.has(prefix)) continue;
  const clashing = sqlFiles.filter((file) => file.startsWith(`${prefix}_`));
  check(clashing.length === 1, `migration number ${prefix} is used twice: ${clashing.join(", ")}`);
}

// ── Statements that fail on a database that already holds rows ───────────────
for (const file of sqlFiles) {
  const statements = readFileSync(join(MIGRATIONS, file), "utf8").split("--> statement-breakpoint");
  for (const statement of statements) {
    const addsColumn = /ALTER\s+TABLE\s+\S+\s+ADD\s/i.test(statement);
    const requiresValue = /\bNOT\s+NULL\b/i.test(statement) && !/\bDEFAULT\b/i.test(statement);
    check(
      !(addsColumn && requiresValue),
      `${file}: adding a NOT NULL column without a DEFAULT fails on every table that has rows\n    ${statement.trim()}`,
    );
  }
}

// ── Shipped migrations are append-only ───────────────────────────────────────
function git(...args: string[]): string | null {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

const base = git("merge-base", "HEAD", "origin/main")?.trim();
if (base) {
  const shipped = git("show", `${base}:${JOURNAL}`);
  const shippedEntries = shipped ? parseJournal(shipped) : [];
  shippedEntries.forEach((entry, position) => {
    const current = entries[position];
    check(
      JSON.stringify(current) === JSON.stringify(entry),
      `journal entry ${position} (${entry.tag}) changed after shipping; add a new migration instead`,
    );
    const shippedSql = git("show", `${base}:${MIGRATIONS}/${entry.tag}.sql`);
    const currentSql = sqlFiles.includes(`${entry.tag}.sql`)
      ? readFileSync(join(MIGRATIONS, `${entry.tag}.sql`), "utf8")
      : null;
    check(
      shippedSql === null || shippedSql === currentSql,
      `${entry.tag}.sql changed after shipping; installs that already ran it never see the edit`,
    );
  });
} else {
  console.log("Migration check: origin/main unavailable, skipped the append-only comparison.");
}

if (failures.length > 0) {
  console.error(
    `Migration check failed:\n${failures.map((failure) => `  - ${failure}`).join("\n")}`,
  );
  process.exit(1);
}
console.log(
  `Migrations OK (${entries.length} entries${base ? `, append-only vs ${base.slice(0, 8)}` : ""}).`,
);
