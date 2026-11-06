// Every step that carries an install from an older release forward. An install
// from any release at or after SUPPORT_FLOOR upgrades straight to this one.
// An entry stops being needed once the floor reaches its `introducedIn`:
// delete it and the code marked `legacy-upgrade: <key>` (upgrades.test.ts
// fails until you do). Raising the floor is a product decision.

export const SUPPORT_FLOOR = "0.0.0";

interface LegacyUpgrade {
  /** First release that ran it; installs from before it need it. */
  readonly introducedIn: string;
  /** File holding the `legacy-upgrade: <key>` code, relative to the repo root. */
  readonly site: string;
  readonly carries: string;
}

export const LEGACY_UPGRADES = {
  cwdDatabase: {
    introducedIn: "0.15.1",
    site: "apps/server/src/db/legacy-upgrades.ts",
    carries:
      "`<cwd>/revv.db` into the app-data dir. The desktop host still starts the server in the old project root (`project_root` in apps/desktop/src/server.rs) so this can find it.",
  },
  preSquashDatabase: {
    introducedIn: "0.1.0",
    site: "apps/server/src/db/legacy-upgrades.ts",
    carries: "pre-release databases from before the migrations were squashed: auth, repos and PRs",
  },
  settingsJson: {
    introducedIn: "0.1.0",
    site: "apps/server/src/services/Settings.ts",
    carries: "`~/.revv/settings.json` (or REVV_SETTINGS_PATH) into the user_settings row",
  },
  plaintextTokens: {
    introducedIn: "0.6.0",
    site: "apps/server/src/services/SecretStore.ts",
    carries: "GitHub tokens in `account.access_token`/`refresh_token` into the secure store",
  },
  launchAgent: {
    introducedIn: "0.32.3",
    site: "apps/desktop/src/server_config.rs",
    carries: "the `com.revv.server` LaunchAgent into desktop-server.json",
  },
} as const satisfies Record<string, LegacyUpgrade>;
