// Every step that carries an install from an older release forward. An install
// from any release at or after SUPPORT_FLOOR upgrades straight to this one.
// An entry stops being needed once the floor reaches its `introducedIn`:
// delete it and the code marked `legacy-upgrade: <key>` (upgrades.test.ts
// fails until you do). Raising the floor is a product decision.

export const SUPPORT_FLOOR = "0.0.0";

interface LegacyUpgrade {
  /** First release that ran it; installs from before it need it. */
  readonly introducedIn: string;
  /** Every file holding `legacy-upgrade: <key>` code, relative to the repo root. */
  readonly sites: readonly string[];
  readonly carries: string;
}

export const LEGACY_UPGRADES = {
  cwdDatabase: {
    introducedIn: "0.15.1",
    sites: ["apps/server/src/db/legacy-upgrades.ts", "scripts/revv"],
    carries:
      "`<cwd>/revv.db` into the app-data dir. The desktop host still starts the server in the old project root (`project_root` in apps/desktop/src/server.rs) so this can find it; the `revv` CLI reads the channel from there until it moves.",
  },
  preSquashDatabase: {
    introducedIn: "0.1.0",
    sites: ["apps/server/src/db/legacy-upgrades.ts"],
    carries: "pre-release databases from before the migrations were squashed: auth, repos and PRs",
  },
  settingsJson: {
    introducedIn: "0.1.0",
    sites: ["apps/server/src/services/Settings.ts"],
    carries: "`~/.revv/settings.json` (or REVV_SETTINGS_PATH) into the user_settings row",
  },
  plaintextTokens: {
    introducedIn: "0.6.0",
    sites: ["apps/server/src/services/github/accounts.ts"],
    carries: "GitHub tokens in `account.access_token`/`refresh_token` into the secure store",
  },
  launchAgent: {
    introducedIn: "0.32.3",
    sites: ["apps/desktop/src/server_config.rs", "scripts/lib/common.sh"],
    carries:
      "the `com.revv.server` LaunchAgent into desktop-server.json (the app on first launch; the installer when it writes the file)",
  },
  providerIdWithoutHost: {
    introducedIn: "0.1.0",
    sites: ["apps/server/src/domain/github-host.ts"],
    carries:
      "accounts whose provider id is the bare `github`, from before accounts were keyed by host",
  },
  revDebugEnv: {
    introducedIn: "0.1.0",
    sites: ["apps/server/src/config.ts"],
    carries: "the `REV_DEBUG` spelling still set by older `.env` files",
  },
  prRefNamespace: {
    introducedIn: "0.21.1",
    sites: ["apps/server/src/services/git/pr-refs.ts"],
    carries: "clones holding `refs/revv/pr-N`, which made `revv/pr-N` resolve to the PR head",
  },
  walkthroughOnlyReviewRounds: {
    introducedIn: "0.17.0",
    sites: ["apps/server/src/services/walkthrough/Walkthrough.ts"],
    carries:
      "PRs reviewed before `review_rounds` existed: their rounds are read off the walkthrough rows",
  },
  driverProviderNames: {
    introducedIn: "0.35.0",
    sites: ["apps/server/src/services/walkthrough/content.ts"],
    carries:
      "walkthrough rows and team-cache snapshots whose provider config names the agent driver (`claude-agent-sdk`, `opencode`, `codex`) instead of the ACP agent id. Snapshots are shared across a team, so a teammate on an older release can still upload one",
  },
} as const satisfies Record<string, LegacyUpgrade>;
