import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { serverEnv } from "../config";
import * as schema from "./schema";
import { customMigrate } from "./migrator";

// ── Pre-squash recovery ─────────────────────────────────────
// TODO(2026-05-17): Revv squashed 21 incremental migrations into 4.
// This block detects old DBs, recovers auth data + repos/PRs, renames
// the old DB aside, and rebuilds from the squashed migrations.
// On the next schema change or after most users have migrated, adapt
// or remove this entire section (detection threshold + recovery logic).
// Detection threshold: FIRST_SQUASHED_WHEN — update if you add new
// squashed migrations with higher timestamps.

const FIRST_SQUASHED_WHEN = 1779000000000;

interface Recovered {
  users: Array<Record<string, unknown>>;
  accounts: Array<Record<string, unknown>>;
  sessions: Array<Record<string, unknown>>;
  repos: Array<Record<string, unknown>>;
  prs: Array<Record<string, unknown>>;
}

function isPreSquashDb(sqlite: Database): boolean {
  try {
    const row = sqlite
      .prepare("SELECT MAX(created_at) AS max_c FROM __drizzle_migrations")
      .get() as Record<string, unknown> | null;
    const maxC = row?.max_c;
    return maxC != null && Number(maxC) < FIRST_SQUASHED_WHEN;
  } catch {
    return false;
  }
}

function extractData(sqlite: Database): Recovered {
  return {
    users: sqlite.query("SELECT * FROM user").all() as Array<Record<string, unknown>>,
    accounts: sqlite.query("SELECT * FROM account").all() as Array<Record<string, unknown>>,
    sessions: sqlite.query("SELECT * FROM session").all() as Array<Record<string, unknown>>,
    repos: sqlite.query("SELECT * FROM repositories").all() as Array<Record<string, unknown>>,
    prs: sqlite.query("SELECT * FROM pull_requests").all() as Array<Record<string, unknown>>,
  };
}

function insertRows(
  sqlite: Database,
  table: string,
  rows: Array<Record<string, unknown>>,
  cols: string[],
  extras?: Record<string, unknown>,
) {
  if (rows.length === 0) return;
  const allCols = extras ? [...cols, ...Object.keys(extras)] : cols;
  const placeholders = allCols.map(() => "?").join(",");
  const sql = `INSERT OR IGNORE INTO ${table} (${allCols.join(",")}) VALUES (${placeholders})`;
  const stmt = sqlite.prepare(sql);
  const extraVals = extras ? Object.values(extras) : [];
  for (const row of rows) {
    // biome-ignore lint/suspicious/noExplicitAny: recovery code, values come from trusted SQLite source
    stmt.run(...(cols.map((c) => row[c] ?? null) as any[]), ...extraVals);
  }
}

function insertData(freshDb: ReturnType<typeof drizzle>, d: Recovered) {
  const sqlite = (freshDb as unknown as { session: { client: Database } }).session.client;

  // user — old has onboarded_at (migration 0140)
  insertRows(sqlite, "user", d.users, [
    "id",
    "name",
    "email",
    "email_verified",
    "image",
    "github_login",
    "created_at",
    "updated_at",
    "onboarded_at",
  ]);

  // account — old has github_login, avatar_url (migration 0170)
  insertRows(sqlite, "account", d.accounts, [
    "id",
    "account_id",
    "provider_id",
    "user_id",
    "access_token",
    "refresh_token",
    "id_token",
    "access_token_expires_at",
    "refresh_token_expires_at",
    "scope",
    "password",
    "github_login",
    "avatar_url",
    "created_at",
    "updated_at",
  ]);

  // session — same schema in both versions
  insertRows(sqlite, "session", d.sessions, [
    "id",
    "expires_at",
    "token",
    "created_at",
    "updated_at",
    "ip_address",
    "user_agent",
    "user_id",
  ]);

  // repositories — account_id is new, backfill per owner→github_login match
  const accountByLogin = new Map<string, string>();
  for (const a of d.accounts) {
    const login = a.github_login as string | undefined;
    const id = a.id as string | undefined;
    if (login && id) accountByLogin.set(login, id);
  }

  // Group repos by matching account owner. Repos without a certain account match
  // are left behind in the backup DB instead of being guessed onto an account.
  const reposByAccount = new Map<string, Array<Record<string, unknown>>>();
  const recoveredRepoIds = new Set<string>();
  const skippedRepos: Array<Record<string, unknown>> = [];
  for (const repo of d.repos) {
    const owner = repo.owner as string | undefined;
    const repoId = repo.id as string | undefined;
    const matchedId = owner ? accountByLogin.get(owner) : undefined;
    if (matchedId && repoId) {
      const list = reposByAccount.get(matchedId) ?? [];
      list.push(repo);
      reposByAccount.set(matchedId, list);
      recoveredRepoIds.add(repoId);
    } else {
      skippedRepos.push(repo);
    }
  }

  for (const [accId, repoList] of reposByAccount) {
    insertRows(
      sqlite,
      "repositories",
      repoList,
      [
        "id",
        "provider",
        "owner",
        "name",
        "full_name",
        "default_branch",
        "avatar_url",
        "added_at",
        "clone_status",
        "clone_path",
        "clone_error",
        "github_host",
      ],
      { account_id: accId },
    );
  }

  if (skippedRepos.length > 0) {
    console.warn(
      `[db] Skipped ${skippedRepos.length} repositories during pre-squash recovery because their owners could not be linked to an account github_login. The original rows remain in the backup DB.`,
    );
  }

  // pull_requests — new cols (requested_reviewers, comments_synced_at,
  // threads_fingerprint) have defaults or are nullable; insert old 22 cols
  const recoverablePrs = d.prs.filter((pr) => {
    const repositoryId = pr.repository_id as string | undefined;
    return repositoryId ? recoveredRepoIds.has(repositoryId) : false;
  });
  const skippedPrCount = d.prs.length - recoverablePrs.length;
  if (skippedPrCount > 0) {
    console.warn(
      `[db] Skipped ${skippedPrCount} pull requests during pre-squash recovery because their repositories were not recovered. The original rows remain in the backup DB.`,
    );
  }

  insertRows(sqlite, "pull_requests", recoverablePrs, [
    "id",
    "external_id",
    "repository_id",
    "title",
    "body",
    "author_login",
    "author_avatar_url",
    "status",
    "review_status",
    "is_draft",
    "source_branch",
    "target_branch",
    "url",
    "additions",
    "deletions",
    "changed_files",
    "head_sha",
    "base_sha",
    "created_at",
    "updated_at",
    "fetched_at",
    "closed_at",
  ]);
}

export function createDb(path?: string) {
  const dbPath = path ?? serverEnv.dbPath;

  const dir = dirname(dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const sqlite = new Database(dbPath, { create: true });
  sqlite.run("PRAGMA journal_mode = WAL");
  sqlite.run("PRAGMA foreign_keys = ON");
  sqlite.run("PRAGMA busy_timeout = 5000");

  // ── Pre-squash recovery ─────────────────────────────────
  if (isPreSquashDb(sqlite)) {
    let data: Recovered;
    try {
      data = extractData(sqlite);
    } catch (err) {
      console.error("[db] Recovery extraction failed, performing plain reset:", err);
      data = { users: [], accounts: [], sessions: [], repos: [], prs: [] };
    }
    sqlite.close();

    const bak = `${dbPath}.bak`;
    if (existsSync(bak)) renameSync(bak, `${bak}.old`);
    renameSync(dbPath, bak);
    console.log(`[db] Old pre-squash DB detected. Backed up to ${bak}, rebuilding fresh...`);
    for (const ext of [".db-wal", ".db-shm"]) {
      const f = `${dbPath}${ext}`;
      if (existsSync(f)) renameSync(f, `${f}.bak`);
    }

    const fresh = new Database(dbPath, { create: true });
    fresh.run("PRAGMA journal_mode = WAL");
    fresh.run("PRAGMA foreign_keys = ON");
    fresh.run("PRAGMA busy_timeout = 5000");
    customMigrate(fresh, fileURLToPath(new URL("./migrations", import.meta.url)));
    const db = drizzle(fresh, { schema });
    insertData(db, data);
    return db;
  }

  // ── Normal path ──────────────────────────────────────────
  customMigrate(sqlite, fileURLToPath(new URL("./migrations", import.meta.url)));
  const db = drizzle(sqlite, { schema });
  return db;
}

export type Db = ReturnType<typeof createDb>;
