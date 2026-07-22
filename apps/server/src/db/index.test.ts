import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { __dbRecoveryTest } from "./index";

function memoryDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  return db;
}

function migrationCount(db: Database, createdAt: number): number {
  const row = db
    .query("SELECT COUNT(*) AS count FROM __drizzle_migrations WHERE created_at = ?")
    .get(createdAt) as { count: number } | null;
  return row?.count ?? 0;
}

describe("review-round migration recovery", () => {
  it("no-ops when the walkthroughs table does not exist", () => {
    const db = memoryDb();

    expect(() => __dbRecoveryTest.recoverUnjournaledReviewRoundMigration(db)).not.toThrow();
    expect(
      db
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'review_rounds'")
        .get(),
    ).toBeNull();
  });

  it("records the review-round migration when artifacts exist without a journal entry", () => {
    const db = memoryDb();
    db.run(`
      CREATE TABLE walkthroughs (
        id text PRIMARY KEY,
        pull_request_id text NOT NULL,
        pr_head_sha text NOT NULL,
        mode text DEFAULT 'reviewer' NOT NULL,
        status text DEFAULT 'complete' NOT NULL,
        parent_walkthrough_id text
      )
    `);

    __dbRecoveryTest.recoverUnjournaledReviewRoundMigration(db);

    expect(
      __dbRecoveryTest.migrationRecorded(db, __dbRecoveryTest.REVIEW_ROUNDS_MIGRATION_WHEN),
    ).toBe(true);
    expect(__dbRecoveryTest.columnExists(db, "walkthroughs", "base_head_sha")).toBe(true);
    expect(__dbRecoveryTest.columnExists(db, "walkthroughs", "generation_mode")).toBe(true);
    expect(
      db
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'review_rounds'")
        .get(),
    ).not.toBeNull();
  });

  it("is idempotent once the review-round migration is journaled", () => {
    const db = memoryDb();
    db.run(`
      CREATE TABLE walkthroughs (
        id text PRIMARY KEY,
        pull_request_id text NOT NULL,
        pr_head_sha text NOT NULL,
        mode text DEFAULT 'reviewer' NOT NULL,
        status text DEFAULT 'complete' NOT NULL,
        parent_walkthrough_id text
      )
    `);

    __dbRecoveryTest.recoverUnjournaledReviewRoundMigration(db);
    __dbRecoveryTest.recoverUnjournaledReviewRoundMigration(db);

    expect(migrationCount(db, __dbRecoveryTest.REVIEW_ROUNDS_MIGRATION_WHEN)).toBe(1);
  });

  it("keeps ensureReviewRoundSchema idempotent", () => {
    const db = memoryDb();
    db.run(`
      CREATE TABLE walkthroughs (
        id text PRIMARY KEY,
        pull_request_id text NOT NULL,
        pr_head_sha text NOT NULL,
        mode text DEFAULT 'reviewer' NOT NULL,
        status text DEFAULT 'complete' NOT NULL
      )
    `);

    __dbRecoveryTest.ensureReviewRoundSchema(db);
    __dbRecoveryTest.ensureReviewRoundSchema(db);

    expect(__dbRecoveryTest.columnExists(db, "walkthroughs", "parent_walkthrough_id")).toBe(true);
    expect(__dbRecoveryTest.columnExists(db, "walkthroughs", "base_head_sha")).toBe(true);
    expect(__dbRecoveryTest.columnExists(db, "walkthroughs", "generation_mode")).toBe(true);
  });
});

describe("mode migration recovery", () => {
  it("records walkthrough mode migration when the mode column exists without a journal entry", () => {
    const db = memoryDb();
    db.run(`
      CREATE TABLE walkthroughs (
        id text PRIMARY KEY,
        pull_request_id text NOT NULL,
        pr_head_sha text NOT NULL,
        mode text DEFAULT 'reviewer' NOT NULL,
        status text DEFAULT 'complete' NOT NULL
      )
    `);

    __dbRecoveryTest.recoverWalkthroughModesMigration(db);

    expect(
      __dbRecoveryTest.migrationRecorded(db, __dbRecoveryTest.WALKTHROUGH_MODES_MIGRATION_WHEN),
    ).toBe(true);
  });

  it("records review-session mode migration when the mode column exists without a journal entry", () => {
    const db = memoryDb();
    db.run(`
      CREATE TABLE review_sessions (
        id text PRIMARY KEY,
        pull_request_id text NOT NULL,
        mode text DEFAULT 'reviewer' NOT NULL,
        status text DEFAULT 'active' NOT NULL
      )
    `);

    __dbRecoveryTest.recoverReviewSessionModesMigration(db);

    expect(
      __dbRecoveryTest.migrationRecorded(db, __dbRecoveryTest.REVIEW_SESSION_MODES_MIGRATION_WHEN),
    ).toBe(true);
  });
});
