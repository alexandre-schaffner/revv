import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { serverEnv } from "../config";
import { appDataDir } from "../paths";
import * as schema from "./schema";

// The DB may hold session bearer tokens; keep it owner-only. The enclosing
// app-data dir is already 0700, but this is a defensive backstop in case
// REVV_DB_PATH points somewhere with looser parent permissions.
const DB_FILE_MODE = 0o600;

/**
 * Resolve the SQLite path. Precedence:
 *   1. explicit `path` arg (tests pass `:memory:`)
 *   2. `REVV_DB_PATH` env override (`serverEnv.dbPath`, non-empty)
 *   3. default: `<appDataDir>/revv.db`
 *
 * The default lives here rather than in `config.ts` because `appDataDir()`
 * reads `serverEnv`, and computing it inside the `Config` schema would form a
 * `config → paths → config` import cycle evaluated before `serverEnv` exists.
 */
export function resolveDbPath(explicit?: string): string {
  if (explicit) return explicit;
  if (serverEnv.dbPath) return serverEnv.dbPath;
  return join(appDataDir(), "revv.db");
}

/**
 * One-time migration of a pre-existing DB from the legacy cwd-relative
 * location (`<cwd>/revv.db` — historically the launchd WorkingDirectory / git
 * checkout) into the canonical app-data location. Moves the WAL/SHM sidecars
 * too so no uncommitted transactions — or session tokens — are left behind.
 * No-op once the canonical DB exists or when already running from the
 * canonical location.
 */
function relocateLegacyDb(targetPath: string): void {
  if (targetPath === ":memory:" || targetPath === "") return;
  const legacy = resolve(process.cwd(), "revv.db");
  if (legacy === targetPath) return; // already canonical
  if (existsSync(targetPath)) return; // canonical DB wins; leave legacy in place
  if (!existsSync(legacy)) return; // nothing to migrate

  mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 });
  renameSync(legacy, targetPath);
  for (const ext of ["-wal", "-shm"]) {
    const from = `${legacy}${ext}`;
    if (existsSync(from)) renameSync(from, `${targetPath}${ext}`);
  }
  console.log(`[db] Migrated database ${legacy} → ${targetPath}`);
}

/**
 * Best-effort restriction of the DB file — and its WAL/SHM sidecars, which
 * hold committed-but-uncheckpointed rows (session tokens included) — to
 * owner-only. Sidecars only exist once WAL mode is active and a write has
 * occurred, so call this *after* migrations run.
 */
function hardenDbFile(dbPath: string): void {
  if (dbPath === ":memory:" || dbPath === "") return;
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      if (existsSync(file)) chmodSync(file, DB_FILE_MODE);
    } catch {
      // Best-effort; the 0700 parent dir is the real backstop.
    }
  }
}

// ── Pre-squash recovery ─────────────────────────────────────
// TODO(2026-05-17): Revv squashed 21 incremental migrations into 4.
// This block detects old DBs, recovers auth data + repos/PRs, renames
// the old DB aside, and rebuilds from the squashed migrations.
// On the next schema change or after most users have migrated, adapt
// or remove this entire section (detection threshold + recovery logic).
// Detection threshold: FIRST_SQUASHED_WHEN — update if you add new
// squashed migrations with higher timestamps.

const FIRST_SQUASHED_WHEN = 1779000000000;
const MIGRATIONS_FOLDER = fileURLToPath(new URL("./migrations", import.meta.url));
const GITHUB_CLIENT_ID_MIGRATION_TAG = "0210_github_client_id";
const GITHUB_CLIENT_ID_MIGRATION_WHEN = 1779590000000;
const WALKTHROUGH_MODES_MIGRATION_TAG = "0220_walkthrough_modes";
const WALKTHROUGH_MODES_MIGRATION_WHEN = 1779595000000;
const REVIEW_SESSION_MODES_MIGRATION_TAG = "0230_review_session_modes";
const REVIEW_SESSION_MODES_MIGRATION_WHEN = 1779600000000;
const REPOSITORY_AVATAR_CONTENT_MIGRATION_TAG = "0240_repository_avatar_content";
const REPOSITORY_AVATAR_CONTENT_MIGRATION_WHEN = 1779610000000;
const CHAT_SESSION_MODEL_MIGRATION_TAG = "0260_chat_session_model";
const CHAT_SESSION_MODEL_MIGRATION_WHEN = 1779620000000;
const UNIFY_AGENT_IDS_MIGRATION_WHEN = 1779625000000;
const CHAT_MESSAGE_ATTACHMENTS_MIGRATION_TAG = "0280_chat_message_attachments";
const CHAT_MESSAGE_ATTACHMENTS_MIGRATION_WHEN = 1779630000000;
const CHAT_ACTIVITY_RESULTS_MIGRATION_TAG = "0290_chat_activity_results";
const CHAT_ACTIVITY_RESULTS_MIGRATION_WHEN = 1779635000000;
const REVIEW_ROUNDS_MIGRATION_TAG = "0300_review_rounds";
const REVIEW_ROUNDS_MIGRATION_WHEN = 1779640000000;

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

function tableExists(sqlite: Database, table: string): boolean {
  const row = sqlite
    .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  return row !== null;
}

function columnExists(sqlite: Database, table: string, column: string): boolean {
  const rows = sqlite.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

function indexExists(sqlite: Database, index: string): boolean {
  const row = sqlite
    .query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
    .get(index);
  return row !== null;
}

function indexColumns(sqlite: Database, index: string): string[] {
  const rows = sqlite.query(`PRAGMA index_info(${index})`).all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

function migrationRecorded(sqlite: Database, createdAt: number): boolean {
  if (!tableExists(sqlite, "__drizzle_migrations")) return false;
  const row = sqlite
    .query("SELECT 1 FROM __drizzle_migrations WHERE created_at = ? LIMIT 1")
    .get(createdAt);
  return row !== null;
}

function migrationHash(tag: string): string {
  const sql = readFileSync(`${MIGRATIONS_FOLDER}/${tag}.sql`, "utf8");
  return createHash("sha256").update(sql).digest("hex");
}

function recordMigration(sqlite: Database, tag: string, createdAt: number): void {
  sqlite.run(`
    CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at numeric
    )
  `);
  if (migrationRecorded(sqlite, createdAt)) return;
  sqlite
    .prepare('INSERT INTO "__drizzle_migrations" ("hash", "created_at") VALUES (?, ?)')
    .run(migrationHash(tag), createdAt);
}

function refreshMigrationHash(sqlite: Database, tag: string, createdAt: number): void {
  if (!migrationRecorded(sqlite, createdAt)) return;
  sqlite
    .prepare('UPDATE "__drizzle_migrations" SET "hash" = ? WHERE "created_at" = ?')
    .run(migrationHash(tag), createdAt);
}

function ensureGithubClientIdColumn(sqlite: Database): void {
  if (!tableExists(sqlite, "user_settings")) return;
  if (columnExists(sqlite, "user_settings", "github_client_id")) return;
  sqlite.run("ALTER TABLE `user_settings` ADD `github_client_id` text DEFAULT '' NOT NULL");
}

function recoverGithubClientIdMigration(sqlite: Database): void {
  if (!tableExists(sqlite, "user_settings")) return;

  const hasColumn = columnExists(sqlite, "user_settings", "github_client_id");
  const isRecorded = migrationRecorded(sqlite, GITHUB_CLIENT_ID_MIGRATION_WHEN);

  if (hasColumn && !isRecorded) {
    recordMigration(sqlite, GITHUB_CLIENT_ID_MIGRATION_TAG, GITHUB_CLIENT_ID_MIGRATION_WHEN);
  }
  if (!hasColumn && isRecorded) {
    ensureGithubClientIdColumn(sqlite);
  }
}

function hasAnyReviewRoundMigrationArtifact(sqlite: Database): boolean {
  return (
    columnExists(sqlite, "walkthroughs", "parent_walkthrough_id") ||
    columnExists(sqlite, "walkthroughs", "base_head_sha") ||
    columnExists(sqlite, "walkthroughs", "generation_mode") ||
    tableExists(sqlite, "review_rounds") ||
    indexExists(sqlite, "walkthroughs_active_pr_head_sha_unique")
  );
}

function ensureWalkthroughModesSchema(sqlite: Database): void {
  if (!tableExists(sqlite, "walkthroughs")) return;

  if (!columnExists(sqlite, "walkthroughs", "mode")) {
    sqlite.run("ALTER TABLE `walkthroughs` ADD `mode` text DEFAULT 'reviewer' NOT NULL");
  }

  sqlite.run("DROP INDEX IF EXISTS `walkthroughs_pr_head_sha_unique`");
  if (!hasAnyReviewRoundMigrationArtifact(sqlite)) {
    sqlite.run("DROP INDEX IF EXISTS `walkthroughs_pr_head_sha_mode_unique`");
    sqlite.run(`
      CREATE UNIQUE INDEX \`walkthroughs_pr_head_sha_mode_unique\`
        ON \`walkthroughs\` (\`pull_request_id\`, \`pr_head_sha\`, \`mode\`)
    `);
  }
}

function recoverWalkthroughModesMigration(sqlite: Database): void {
  if (!tableExists(sqlite, "walkthroughs")) return;

  const hasMode = columnExists(sqlite, "walkthroughs", "mode");
  const isRecorded = migrationRecorded(sqlite, WALKTHROUGH_MODES_MIGRATION_WHEN);
  if (!hasMode && (isRecorded || hasAnyReviewRoundMigrationArtifact(sqlite))) {
    ensureWalkthroughModesSchema(sqlite);
    recordMigration(sqlite, WALKTHROUGH_MODES_MIGRATION_TAG, WALKTHROUGH_MODES_MIGRATION_WHEN);
    refreshMigrationHash(sqlite, WALKTHROUGH_MODES_MIGRATION_TAG, WALKTHROUGH_MODES_MIGRATION_WHEN);
  }
}

function ensureReviewSessionModesSchema(sqlite: Database): void {
  if (!tableExists(sqlite, "review_sessions")) return;

  if (!columnExists(sqlite, "review_sessions", "mode")) {
    sqlite.run("ALTER TABLE `review_sessions` ADD `mode` text DEFAULT 'reviewer' NOT NULL");
  }
  sqlite.run(`
    CREATE INDEX IF NOT EXISTS \`review_sessions_pr_mode_status_idx\`
      ON \`review_sessions\` (\`pull_request_id\`, \`mode\`, \`status\`)
  `);
}

function recoverReviewSessionModesMigration(sqlite: Database): void {
  if (!tableExists(sqlite, "review_sessions")) return;

  const hasMode = columnExists(sqlite, "review_sessions", "mode");
  const isRecorded = migrationRecorded(sqlite, REVIEW_SESSION_MODES_MIGRATION_WHEN);
  if (!hasMode && (isRecorded || hasAnyReviewRoundMigrationArtifact(sqlite))) {
    ensureReviewSessionModesSchema(sqlite);
    recordMigration(
      sqlite,
      REVIEW_SESSION_MODES_MIGRATION_TAG,
      REVIEW_SESSION_MODES_MIGRATION_WHEN,
    );
    refreshMigrationHash(
      sqlite,
      REVIEW_SESSION_MODES_MIGRATION_TAG,
      REVIEW_SESSION_MODES_MIGRATION_WHEN,
    );
  }
}

function ensureAvatarContentSchema(sqlite: Database): void {
  if (
    tableExists(sqlite, "repositories") &&
    !columnExists(sqlite, "repositories", "avatar_content")
  ) {
    sqlite.run("ALTER TABLE `repositories` ADD `avatar_content` text");
  }
  if (
    tableExists(sqlite, "remote_users") &&
    !columnExists(sqlite, "remote_users", "avatar_content")
  ) {
    sqlite.run("ALTER TABLE `remote_users` ADD `avatar_content` text");
  }
}

function recoverAvatarContentMigrations(sqlite: Database): void {
  if (
    tableExists(sqlite, "remote_users") &&
    !columnExists(sqlite, "remote_users", "avatar_content")
  ) {
    sqlite.run("ALTER TABLE `remote_users` ADD `avatar_content` text");
  }

  if (!tableExists(sqlite, "repositories")) return;
  const hasColumn = columnExists(sqlite, "repositories", "avatar_content");
  const isRecorded = migrationRecorded(sqlite, REPOSITORY_AVATAR_CONTENT_MIGRATION_WHEN);

  if (hasColumn && !isRecorded) {
    recordMigration(
      sqlite,
      REPOSITORY_AVATAR_CONTENT_MIGRATION_TAG,
      REPOSITORY_AVATAR_CONTENT_MIGRATION_WHEN,
    );
  }
  if (!hasColumn && isRecorded) {
    sqlite.run("ALTER TABLE `repositories` ADD `avatar_content` text");
  }
}

function hasAnyChatSessionModelMigrationArtifact(sqlite: Database): boolean {
  return (
    columnExists(sqlite, "chat_sessions", "model") ||
    indexExists(sqlite, "chat_sessions_pr_agent_model_sha_unique")
  );
}

function hasLaterChatSessionMigration(sqlite: Database): boolean {
  return (
    migrationRecorded(sqlite, UNIFY_AGENT_IDS_MIGRATION_WHEN) ||
    migrationRecorded(sqlite, CHAT_MESSAGE_ATTACHMENTS_MIGRATION_WHEN) ||
    migrationRecorded(sqlite, CHAT_ACTIVITY_RESULTS_MIGRATION_WHEN) ||
    migrationRecorded(sqlite, REVIEW_ROUNDS_MIGRATION_WHEN) ||
    hasAnyReviewRoundMigrationArtifact(sqlite)
  );
}

function ensureChatSessionModelSchema(sqlite: Database): void {
  if (!tableExists(sqlite, "chat_sessions")) return;

  if (!columnExists(sqlite, "chat_sessions", "model")) {
    sqlite.run("ALTER TABLE `chat_sessions` ADD `model` text DEFAULT '' NOT NULL");
  }

  sqlite.run("DROP INDEX IF EXISTS `chat_sessions_pr_agent_sha_unique`");

  const expectedColumns = ["pull_request_id", "agent", "model", "pr_head_sha"];
  const currentColumns = indexColumns(sqlite, "chat_sessions_pr_agent_model_sha_unique");
  if (currentColumns.join("\0") !== expectedColumns.join("\0")) {
    sqlite.run("DROP INDEX IF EXISTS `chat_sessions_pr_agent_model_sha_unique`");
    sqlite.run(`
      CREATE UNIQUE INDEX \`chat_sessions_pr_agent_model_sha_unique\`
        ON \`chat_sessions\` (\`pull_request_id\`, \`agent\`, \`model\`, \`pr_head_sha\`)
    `);
  }
}

function recoverChatSessionModelMigration(sqlite: Database): void {
  if (!tableExists(sqlite, "chat_sessions")) return;

  const isRecorded = migrationRecorded(sqlite, CHAT_SESSION_MODEL_MIGRATION_WHEN);
  const hasArtifacts = hasAnyChatSessionModelMigrationArtifact(sqlite);
  if (!isRecorded && !hasArtifacts && !hasLaterChatSessionMigration(sqlite)) return;

  ensureChatSessionModelSchema(sqlite);
  recordMigration(sqlite, CHAT_SESSION_MODEL_MIGRATION_TAG, CHAT_SESSION_MODEL_MIGRATION_WHEN);
  refreshMigrationHash(sqlite, CHAT_SESSION_MODEL_MIGRATION_TAG, CHAT_SESSION_MODEL_MIGRATION_WHEN);
}

function hasLaterChatMessageMigration(sqlite: Database): boolean {
  return (
    migrationRecorded(sqlite, CHAT_ACTIVITY_RESULTS_MIGRATION_WHEN) ||
    migrationRecorded(sqlite, REVIEW_ROUNDS_MIGRATION_WHEN) ||
    hasAnyReviewRoundMigrationArtifact(sqlite)
  );
}

function ensureChatMessageAttachmentsSchema(sqlite: Database): void {
  if (!tableExists(sqlite, "chat_messages")) return;
  if (columnExists(sqlite, "chat_messages", "attachments_json")) return;
  sqlite.run("ALTER TABLE `chat_messages` ADD `attachments_json` text");
}

function recoverChatMessageAttachmentsMigration(sqlite: Database): void {
  if (!tableExists(sqlite, "chat_messages")) return;

  const isRecorded = migrationRecorded(sqlite, CHAT_MESSAGE_ATTACHMENTS_MIGRATION_WHEN);
  const hasColumn = columnExists(sqlite, "chat_messages", "attachments_json");
  if (!isRecorded && !hasColumn && !hasLaterChatMessageMigration(sqlite)) return;

  ensureChatMessageAttachmentsSchema(sqlite);
  recordMigration(
    sqlite,
    CHAT_MESSAGE_ATTACHMENTS_MIGRATION_TAG,
    CHAT_MESSAGE_ATTACHMENTS_MIGRATION_WHEN,
  );
  refreshMigrationHash(
    sqlite,
    CHAT_MESSAGE_ATTACHMENTS_MIGRATION_TAG,
    CHAT_MESSAGE_ATTACHMENTS_MIGRATION_WHEN,
  );
}

function ensureChatActivityResultsSchema(sqlite: Database): void {
  if (!tableExists(sqlite, "chat_activities")) return;

  if (!columnExists(sqlite, "chat_activities", "call_id")) {
    sqlite.run("ALTER TABLE `chat_activities` ADD `call_id` text");
  }
  if (!columnExists(sqlite, "chat_activities", "output")) {
    sqlite.run("ALTER TABLE `chat_activities` ADD `output` text");
  }
  if (!columnExists(sqlite, "chat_activities", "is_error")) {
    sqlite.run("ALTER TABLE `chat_activities` ADD `is_error` integer");
  }
  sqlite.run(`
    CREATE INDEX IF NOT EXISTS \`chat_activities_session_call_idx\`
      ON \`chat_activities\` (\`chat_session_id\`, \`call_id\`)
  `);
}

function recoverChatActivityResultsMigration(sqlite: Database): void {
  if (!tableExists(sqlite, "chat_activities")) return;

  const isRecorded = migrationRecorded(sqlite, CHAT_ACTIVITY_RESULTS_MIGRATION_WHEN);
  const hasArtifacts =
    columnExists(sqlite, "chat_activities", "call_id") ||
    columnExists(sqlite, "chat_activities", "output") ||
    columnExists(sqlite, "chat_activities", "is_error") ||
    indexExists(sqlite, "chat_activities_session_call_idx");
  if (
    !isRecorded &&
    !hasArtifacts &&
    !migrationRecorded(sqlite, REVIEW_ROUNDS_MIGRATION_WHEN) &&
    !hasAnyReviewRoundMigrationArtifact(sqlite)
  ) {
    return;
  }

  ensureChatActivityResultsSchema(sqlite);
  recordMigration(
    sqlite,
    CHAT_ACTIVITY_RESULTS_MIGRATION_TAG,
    CHAT_ACTIVITY_RESULTS_MIGRATION_WHEN,
  );
  refreshMigrationHash(
    sqlite,
    CHAT_ACTIVITY_RESULTS_MIGRATION_TAG,
    CHAT_ACTIVITY_RESULTS_MIGRATION_WHEN,
  );
}

/**
 * Defensive repair for local databases that already received part or all of
 * the review-round schema outside the Drizzle journal. Keep this idempotent
 * and narrow: clean DBs no-op, poisoned DBs get the missing review-round
 * schema before services start touching it.
 */
function ensureReviewRoundSchema(sqlite: Database) {
  if (!tableExists(sqlite, "walkthroughs")) return;

  if (!columnExists(sqlite, "walkthroughs", "parent_walkthrough_id")) {
    sqlite.run(
      "ALTER TABLE `walkthroughs` ADD `parent_walkthrough_id` text REFERENCES `walkthroughs`(`id`) ON DELETE set null",
    );
  }
  if (!columnExists(sqlite, "walkthroughs", "base_head_sha")) {
    sqlite.run("ALTER TABLE `walkthroughs` ADD `base_head_sha` text");
  }
  if (!columnExists(sqlite, "walkthroughs", "generation_mode")) {
    sqlite.run("ALTER TABLE `walkthroughs` ADD `generation_mode` text DEFAULT 'full' NOT NULL");
  }

  sqlite.run("DROP INDEX IF EXISTS `walkthroughs_pr_head_sha_unique`");
  sqlite.run("DROP INDEX IF EXISTS `walkthroughs_pr_head_sha_mode_unique`");
  const activeIndexColumns = indexColumns(sqlite, "walkthroughs_active_pr_head_sha_unique");
  const expectedActiveIndexColumns = ["pull_request_id", "pr_head_sha", "mode", "generation_mode"];
  if (activeIndexColumns.join("\0") !== expectedActiveIndexColumns.join("\0")) {
    sqlite.run("DROP INDEX IF EXISTS `walkthroughs_active_pr_head_sha_unique`");
    sqlite.run(`
      CREATE UNIQUE INDEX \`walkthroughs_active_pr_head_sha_unique\`
        ON \`walkthroughs\` (\`pull_request_id\`, \`pr_head_sha\`, \`mode\`, \`generation_mode\`)
        WHERE \`status\` <> 'superseded'
    `);
  }

  sqlite.run(`
    CREATE TABLE IF NOT EXISTS \`review_rounds\` (
      \`id\` text PRIMARY KEY NOT NULL,
      \`pull_request_id\` text NOT NULL,
      \`review_session_id\` text NOT NULL,
      \`walkthrough_id\` text NOT NULL,
      \`previous_walkthrough_id\` text,
      \`round_number\` integer NOT NULL,
      \`kind\` text DEFAULT 'full' NOT NULL,
      \`visibility\` text DEFAULT 'visible' NOT NULL,
      \`status\` text DEFAULT 'generating' NOT NULL,
      \`from_sha\` text,
      \`to_sha\` text NOT NULL,
      \`created_at\` text NOT NULL,
      \`completed_at\` text,
      FOREIGN KEY (\`pull_request_id\`) REFERENCES \`pull_requests\`(\`id\`) ON UPDATE no action ON DELETE cascade,
      FOREIGN KEY (\`review_session_id\`) REFERENCES \`review_sessions\`(\`id\`) ON UPDATE no action ON DELETE cascade,
      FOREIGN KEY (\`walkthrough_id\`) REFERENCES \`walkthroughs\`(\`id\`) ON UPDATE no action ON DELETE cascade,
      FOREIGN KEY (\`previous_walkthrough_id\`) REFERENCES \`walkthroughs\`(\`id\`) ON UPDATE no action ON DELETE set null
    )
  `);
  sqlite.run(`
    CREATE INDEX IF NOT EXISTS \`review_rounds_pr_round_idx\`
      ON \`review_rounds\` (\`pull_request_id\`, \`round_number\`)
  `);
  sqlite.run(`
    CREATE INDEX IF NOT EXISTS \`review_rounds_walkthrough_idx\`
      ON \`review_rounds\` (\`walkthrough_id\`)
  `);
}

/**
 * Older local builds repaired the review-round schema after Drizzle ran but
 * did not write the matching migration journal entry. Those databases crash
 * on the next boot because Drizzle replays 0240 and hits duplicate columns.
 */
function recoverUnjournaledReviewRoundMigration(sqlite: Database): void {
  if (!tableExists(sqlite, "walkthroughs")) return;
  if (migrationRecorded(sqlite, REVIEW_ROUNDS_MIGRATION_WHEN)) return;
  if (!hasAnyReviewRoundMigrationArtifact(sqlite)) return;

  ensureReviewRoundSchema(sqlite);
  recordMigration(sqlite, REVIEW_ROUNDS_MIGRATION_TAG, REVIEW_ROUNDS_MIGRATION_WHEN);
}

export function createDb(path?: string) {
  const dbPath = resolveDbPath(path);

  // Move a legacy cwd-relative DB into place before opening, so existing
  // installs keep their onboarding/settings across the update that ships this.
  relocateLegacyDb(dbPath);

  const dir = dirname(dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

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
    const db = drizzle(fresh, { schema });
    recoverGithubClientIdMigration(fresh);
    recoverWalkthroughModesMigration(fresh);
    recoverReviewSessionModesMigration(fresh);
    recoverAvatarContentMigrations(fresh);
    recoverChatSessionModelMigration(fresh);
    recoverChatMessageAttachmentsMigration(fresh);
    recoverChatActivityResultsMigration(fresh);
    recoverUnjournaledReviewRoundMigration(fresh);
    migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    ensureGithubClientIdColumn(fresh);
    ensureAvatarContentSchema(fresh);
    ensureChatSessionModelSchema(fresh);
    ensureChatMessageAttachmentsSchema(fresh);
    ensureChatActivityResultsSchema(fresh);
    ensureWalkthroughModesSchema(fresh);
    ensureReviewSessionModesSchema(fresh);
    ensureReviewRoundSchema(fresh);
    insertData(db, data);
    hardenDbFile(dbPath);
    return db;
  }

  // ── Normal path ──────────────────────────────────────────
  const db = drizzle(sqlite, { schema });
  recoverGithubClientIdMigration(sqlite);
  recoverWalkthroughModesMigration(sqlite);
  recoverReviewSessionModesMigration(sqlite);
  recoverAvatarContentMigrations(sqlite);
  recoverChatSessionModelMigration(sqlite);
  recoverChatMessageAttachmentsMigration(sqlite);
  recoverChatActivityResultsMigration(sqlite);
  recoverUnjournaledReviewRoundMigration(sqlite);
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  ensureGithubClientIdColumn(sqlite);
  ensureAvatarContentSchema(sqlite);
  ensureChatSessionModelSchema(sqlite);
  ensureChatMessageAttachmentsSchema(sqlite);
  ensureChatActivityResultsSchema(sqlite);
  ensureWalkthroughModesSchema(sqlite);
  ensureReviewSessionModesSchema(sqlite);
  ensureReviewRoundSchema(sqlite);
  hardenDbFile(dbPath);
  return db;
}

export type Db = ReturnType<typeof createDb>;
