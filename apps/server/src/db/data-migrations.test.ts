// Data migrations rewrite rows the schema diff can't see, so the upgrade
// replay in `migration-upgrade.test.ts` doesn't check their result.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RECAP_EMPTY_WINDOW_LEDE } from "@revv/shared";
import { EXTERNAL_AGENT_SCOPES } from "../services/ExternalIntegrations";
import { createDb } from "./index";

describe("walkthrough:generate scope migration", () => {
  const migration = readFileSync(
    join(import.meta.dir, "migrations/0430_external_walkthrough_generate_scope.sql"),
    "utf8",
  );

  it("grants the scope to credentials issued before it existed, once", () => {
    const db = createDb(":memory:");
    db.$client.run(
      "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      ["user-1", "Author", "author@example.com", 1, Date.now(), Date.now()],
    );
    db.$client.run(
      "INSERT INTO account (id, account_id, provider_id, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      ["account-1", "github-user", "github:github.com", "user-1", Date.now(), Date.now()],
    );
    const legacyScopes = EXTERNAL_AGENT_SCOPES.filter((scope) => scope !== "walkthrough:generate");
    db.$client.run(
      `INSERT INTO external_integrations
        (id, provider, user_id, account_id, token_hash, scopes, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "integration-1",
        "claude-code",
        "user-1",
        "account-1",
        "digest",
        JSON.stringify(legacyScopes),
        "2026-10-01T00:00:00.000Z",
        "2026-12-30T00:00:00.000Z",
      ],
    );

    db.$client.run(migration);
    db.$client.run(migration);

    const row = db.$client
      .query("SELECT scopes FROM external_integrations WHERE id = ?")
      .get("integration-1") as { scopes: string };
    expect(JSON.parse(row.scopes)).toEqual([...legacyScopes, "walkthrough:generate"]);
    db.$client.close();
  });
});

describe("recap stopped-status migration", () => {
  const migration = readFileSync(
    join(import.meta.dir, "migrations/0480_recap_stopped_status.sql"),
    "utf8",
  );
  const EMPTY = "No archived or open PRs found for this window";

  it("turns recorded stops into `stopped` and closed empty windows into quiet recaps", () => {
    const db = createDb(":memory:");
    const now = Date.now();
    db.$client.run(
      "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      ["user-1", "Author", "author@example.com", 1, now, now],
    );
    db.$client.run(
      "INSERT INTO account (id, account_id, provider_id, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      ["account-1", "github-user", "github:github.com", "user-1", now, now],
    );
    db.$client.run(
      "INSERT INTO repositories (id, owner, name, full_name, added_at, account_id) VALUES (?, ?, ?, ?, ?, ?)",
      ["repo-1", "acme", "web", "acme/web", new Date(now).toISOString(), "account-1"],
    );
    // Far ahead of any run, so the window stays open even if the test straddles midnight UTC.
    const stillOpen = "2999-01-01T00:00:00.000Z";
    const insert = (id: string, period: string, start: string, message: string | null) =>
      db.$client.run(
        `INSERT INTO project_recaps
          (id, repository_id, period, period_start, period_end, status, generated_at, error_message)
         VALUES (?, 'repo-1', ?, ?, ?, 'error', ?, ?)`,
        [id, period, start, start, start, message],
      );
    insert("stopped", "daily", "2026-06-03T00:00:00.000Z", "Cancelled by user");
    insert("quiet-day", "daily", "2026-06-03T00:00:00.000Z", EMPTY);
    insert("quiet-week", "weekly", "2026-06-01T00:00:00.000Z", EMPTY);
    insert("open-day", "daily", stillOpen, EMPTY);
    insert("failed", "daily", "2026-06-03T00:00:00.000Z", "Agent crashed");

    db.$client.run(migration);
    db.$client.run(migration);

    const rows = new Map(
      (
        db.$client.query("SELECT id, status, error_message, lede FROM project_recaps").all() as {
          id: string;
          status: string;
          error_message: string | null;
          lede: string;
        }[]
      ).map((r) => [r.id, r]),
    );
    expect(rows.get("stopped")).toMatchObject({ status: "stopped", error_message: null });
    for (const id of ["quiet-day", "quiet-week"]) {
      expect(rows.get(id)).toMatchObject({
        status: "complete",
        error_message: null,
        lede: RECAP_EMPTY_WINDOW_LEDE,
      });
    }
    expect(rows.get("open-day")).toMatchObject({ status: "error", error_message: EMPTY });
    expect(rows.get("failed")).toMatchObject({ status: "error", error_message: "Agent crashed" });
    db.$client.close();
  });
});

describe("walkthrough end-reason migration", () => {
  // Only the backfill: the rest of the file adds the columns, which a booted DB has.
  const backfill = readFileSync(join(import.meta.dir, "migrations/0510_jobs_kernel.sql"), "utf8")
    .split("--> statement-breakpoint")
    .at(-1);

  it("records a stop that only its message told apart as `cancelled`", () => {
    const db = createDb(":memory:");
    db.$client.run("PRAGMA foreign_keys = OFF");
    const insert = (id: string, status: string, message: string | null) =>
      db.$client.run(
        `INSERT INTO walkthroughs
          (id, review_session_id, pull_request_id, status, error_message, generated_at, model_used, pr_head_sha)
         VALUES (?, 's', 'pr', ?, ?, '2026-11-01T00:00:00Z', 'm', ?)`,
        [id, status, message, id],
      );
    insert("stopped", "error", "Walkthrough cancelled");
    insert("failed", "error", "agent crashed");
    insert("done", "complete", null);

    db.$client.run(backfill ?? "");

    const reasons = db.$client
      .query("SELECT id, end_reason AS reason FROM walkthroughs ORDER BY id")
      .all();
    expect(reasons).toEqual([
      { id: "done", reason: null },
      { id: "failed", reason: null },
      { id: "stopped", reason: "cancelled" },
    ]);
    db.$client.close();
  });
});

describe("account client_id migration", () => {
  // Only the backfill: the column itself is already on a booted DB.
  const backfill = readFileSync(
    join(import.meta.dir, "migrations/0530_account_client_id.sql"),
    "utf8",
  )
    .split("--> statement-breakpoint")
    .at(-1);

  it("gives accounts on the settings' GitHub Enterprise host the saved client ID, and no one else", () => {
    const db = createDb(":memory:");
    const columns = db.$client
      .query(
        "SELECT name, type, \"notnull\" AS required, dflt_value AS dflt FROM pragma_table_info('user_settings')",
      )
      .all() as Array<{ name: string; type: string; required: number; dflt: string | null }>;
    const filled = columns.filter((c) => c.name !== "id" && c.required && c.dflt === null);
    db.$client.run(
      `INSERT INTO user_settings (id, github_host, github_client_id${filled.map((c) => `, ${c.name}`).join("")})
       VALUES ('default', ' GHE.example.com ', 'Ov23byoclientid'${filled.map((c) => (c.type === "integer" ? ", 0" : ", ''")).join("")})`,
    );
    db.$client.run(
      "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('u', 'U', 'u@x', 1, 0, 0)",
    );
    const insert = (id: string, providerId: string) =>
      db.$client.run(
        "INSERT INTO account (id, account_id, provider_id, user_id, created_at, updated_at) VALUES (?, ?, ?, 'u', 0, 0)",
        [id, id, providerId],
      );
    insert("ghe", "github:ghe.example.com");
    insert("dotcom", "github:github.com");
    insert("other", "github:other.example.com");

    db.$client.run(backfill ?? "");

    expect(
      db.$client.query("SELECT id, client_id AS clientId FROM account ORDER BY id").all(),
    ).toEqual([
      { id: "dotcom", clientId: null },
      { id: "ghe", clientId: "Ov23byoclientid" },
      { id: "other", clientId: null },
    ]);
    db.$client.close();
  });
});
