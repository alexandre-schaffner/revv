// Data migrations rewrite rows the schema diff can't see, so the upgrade
// replay in `migration-upgrade.test.ts` doesn't check their result.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
