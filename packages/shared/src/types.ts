import type { AcpAgentId, ThinkingEffortSetting } from "./acp-agents";
import type { BaseConflictStrategy } from "./base-conflicts";
import type { UpdateChannel } from "./constants";
import type { JevSettings } from "./jev-settings";

/**
 * Per-feature override for which agent generates project recaps.
 * `'auto'` (default) inherits the global `aiAgent`; an explicit ACP agent id
 * pins recap generation to that agent regardless of the global choice. Lets a
 * user run Claude Code for interactive walkthroughs but keep background recaps
 * on opencode (cheaper, unattended), or vice versa.
 */
export type RecapAgentChoice = "auto" | AcpAgentId;

export type ThemePreference = "system" | "light" | "dark";

export type DiffViewMode = "unified" | "split";

export interface UserSettings {
  id: string;
  aiProvider: string;
  aiModel: string;
  aiThinkingEffort: ThinkingEffortSetting;
  /**
   * Selected ACP agent id (one of `ACP_AGENTS`, e.g. `claude-code`, `opencode`,
   * `codex`, `cursor`). The single agent that drives chat, walkthrough, and
   * recap generation.
   */
  aiAgent: AcpAgentId;
  /**
   * Low-cost model used for one-shot, no-tools PR-aware suggestion
   * generation (right-panel empty-state prompts). Follows the global
   * `aiAgent` — picked from that agent's catalog. Defaults to a cheap model
   * (e.g. Haiku for Claude Code) so generating suggestions for every PR open
   * doesn't burn the same tokens as the main review agent.
   */
  aiSuggestionsModel: string;
  /**
   * Maximum number of agent turns (tool-use round trips) within a single
   * chat turn or walkthrough generation. Higher values let complex PRs and
   * long chat threads complete without truncation, at the cost of
   * potentially longer runs.
   */
  aiMaxTurns: number;
  theme: ThemePreference;
  diffViewMode: DiffViewMode;
  autoFetchInterval: number;
  /**
   * Daily / weekly project-recap scheduler toggles. v1 keeps this minimal —
   * just on/off per cadence; no custom hour-of-day. UTC throughout (see
   * plan: cross-cutting decisions). Adding finer-grained scheduling later
   * doesn't need a wire-format change since this is a nested object.
   */
  recap: {
    enabled: boolean;
    dailyEnabled: boolean;
    weeklyEnabled: boolean;
    /**
     * Per-feature agent override. `'auto'` (default) follows the global
     * `aiAgent`; an explicit ACP agent id pins recap generation to that
     * agent regardless of the global choice.
     */
    agent: RecapAgentChoice;
  };
  /**
   * GitHub host the app authenticates against. `'github.com'` for public
   * GitHub (the default), or any GitHub Enterprise host the user enters
   * during onboarding. Consumed by the device-flow routes to build per-host
   * OAuth and API URLs.
   */
  githubHost: string;
  /**
   * GitHub OAuth/App client ID for a user-added GitHub Enterprise host.
   * Empty string for `github.com`, whose client ID comes from server config.
   * When a user points Revv at their own GHE instance they register a GitHub
   * App there and paste its public client ID here — there is no bundled
   * registration on a customer's host. An `Iv…` prefix marks a GitHub App
   * (device flow sends no scope); `Ov…` marks a classic OAuth App.
   */
  githubClientId: string;
  /**
   * Team-shared walkthrough cache settings. Backed by a single GCS
   * bucket — IAM grants are the team boundary. When `enabled` is off,
   * the entire feature short-circuits (no probe, no upload, no
   * download). The two direction toggles let a teammate participate
   * read-only or write-only.
   */
  cache: {
    enabled: boolean;
    bucket: string;
    uploadsEnabled: boolean;
    downloadsEnabled: boolean;
    /**
     * SSHSIG-based content signing. Signs blobs on push and verifies
     * on fetch using the uploader's GitHub SSH key and repo-level
     * collaborator permission as the trust anchor.
     */
    signing: {
      /** `'strict'` (default) rejects unsigned/invalid blobs; `'permissive'` warns but accepts; `'off'` skips crypto entirely. */
      mode: "off" | "permissive" | "strict";
      /** Path to the SSH private key. Empty string = auto-detect from `~/.ssh/`. */
      keyPath: string;
      /** GitHub hosts whose signers are trusted. Defaults to the user's authenticated hosts. */
      trustedSignerHosts: string[];
    };
  };
  /**
   * TypeSafe System One (Jev) — calibrated decisions for closed-set judgments
   * the pipeline would otherwise spend an agent turn on. Every hook degrades
   * to today's behaviour when Jev is off, unconfigured, or unreachable.
   * Per-feature switches, not one master flag, since each hook is
   * independently reversible.
   */
  jev: JevSettings;
  /**
   * Release channel the in-app updater (and `revv update` CLI) reads from.
   * `'stable'` (default) tracks the latest `vX.Y.Z` tag published by
   * release-please. `'nightly'` tracks the moving `nightly` tag — built from
   * every push to `main`. Nightly users skip the 48-hour stable cooldown so
   * they're notified of new builds instantly.
   */
  updateChannel: UpdateChannel;
  /** How "Resolve with agent" brings a conflicting PR up to date with its base. */
  baseConflictStrategy: BaseConflictStrategy;
}
