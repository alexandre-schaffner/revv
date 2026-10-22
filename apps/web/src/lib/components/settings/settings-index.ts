// Static map of the settings surface: one entry per pane, one per row.
//
// Row ids are the `data-setting-id` anchors `SettingsRow` renders, so search
// can open the right pane, scroll the row into view, and flash it. Adding a
// row without an entry here just makes it unsearchable; adding an entry whose
// row doesn't render (e.g. behind a master switch that's off) falls back to the
// pane's first row.

import { EXTERNAL_AGENT_PROVIDER_NAMES, EXTERNAL_AGENT_PROVIDERS } from "@revv/shared";
import type { SettingsSectionId } from "$lib/stores/settingsModal.svelte";

export interface SettingsPaneMeta {
  title: string;
  description: string;
}

export const SETTINGS_PANES: Record<SettingsSectionId, SettingsPaneMeta> = {
  general: {
    title: "General",
    description: "Appearance, how diffs render, and how often Revv checks GitHub.",
  },
  account: {
    title: "Account",
    description: "The GitHub identity Revv signs in with.",
  },
  repositories: {
    title: "Repositories",
    description: "The repositories whose pull requests Revv syncs.",
  },
  ai: {
    title: "AI agent",
    description: "The coding agent that writes walkthroughs and answers in chat.",
  },
  recap: {
    title: "Recaps",
    description: "Daily and weekly summaries of what shipped in each repository.",
  },
  jev: {
    title: "TypeSafe",
    description: "Calibrated yes-or-no judgments where a full agent turn is overkill.",
  },
  integrations: {
    title: "Integrations",
    description: "Let a coding agent read and act on the current pull request's review.",
  },
  cache: {
    title: "Team cache",
    description: "Share finished walkthroughs with teammates through a storage bucket.",
  },
  updates: {
    title: "Updates",
    description: "Which releases Revv installs, and the build you're running.",
  },
};

export interface SettingsIndexEntry {
  id: string;
  pane: SettingsSectionId;
  label: string;
  keywords: readonly string[];
}

export const SETTINGS_INDEX: readonly SettingsIndexEntry[] = [
  // General
  {
    id: "theme",
    pane: "general",
    label: "Theme",
    keywords: ["appearance", "dark", "light", "mode"],
  },
  {
    id: "diff-theme",
    pane: "general",
    label: "Diff theme",
    keywords: ["syntax", "code", "colors", "dark", "light"],
  },
  {
    id: "diff-layout",
    pane: "general",
    label: "Default diff layout",
    keywords: ["split", "unified", "side by side", "view"],
  },
  {
    id: "diff-wrap",
    pane: "general",
    label: "Wrap long lines",
    keywords: ["wrap", "soft wrap", "overflow", "scroll"],
  },
  {
    id: "sync-interval",
    pane: "general",
    label: "Refresh interval",
    keywords: ["sync", "poll", "fetch", "github", "minutes"],
  },
  {
    id: "replay-onboarding",
    pane: "general",
    label: "Replay onboarding",
    keywords: ["setup", "welcome", "tutorial", "reset"],
  },
  // Account
  {
    id: "account-identity",
    pane: "account",
    label: "Signed-in account",
    keywords: ["github", "sign out", "logout", "email", "user"],
  },
  {
    id: "account-revoke",
    pane: "account",
    label: "Revoke access on GitHub",
    keywords: ["authorized applications", "oauth", "token", "permissions"],
  },
  {
    id: "account-remove",
    pane: "account",
    label: "Remove account",
    keywords: ["delete", "danger", "erase", "local data"],
  },
  // Repositories
  {
    id: "repositories-list",
    pane: "repositories",
    label: "Tracked repositories",
    keywords: ["repos", "remove", "delete", "add", "track"],
  },
  // AI agent
  {
    id: "ai-provider",
    pane: "ai",
    label: "Agent",
    keywords: ["provider", "claude code", "codex", "opencode", "cursor", "install", "sign in"],
  },
  {
    id: "ai-review-model",
    pane: "ai",
    label: "Review model",
    keywords: ["model", "opus", "sonnet", "gpt", "llm"],
  },
  {
    id: "ai-thinking-effort",
    pane: "ai",
    label: "Thinking effort",
    keywords: ["reasoning", "ultrathink", "effort", "depth"],
  },
  {
    id: "ai-suggestions-model",
    pane: "ai",
    label: "Suggestions model",
    keywords: ["prompts", "cheap", "haiku", "right panel"],
  },
  {
    id: "ai-max-turns",
    pane: "ai",
    label: "Max turns",
    keywords: ["limit", "tool calls", "budget", "steps"],
  },
  {
    id: "ai-keychain",
    pane: "ai",
    label: "Keychain access",
    keywords: ["macos", "keychain", "background", "credentials"],
  },
  // Recaps
  {
    id: "recap-enabled",
    pane: "recap",
    label: "Generate recaps",
    keywords: ["summary", "digest", "project recap"],
  },
  { id: "recap-daily", pane: "recap", label: "Daily recap", keywords: ["every day", "schedule"] },
  {
    id: "recap-weekly",
    pane: "recap",
    label: "Weekly recap",
    keywords: ["every week", "schedule"],
  },
  { id: "recap-agent", pane: "recap", label: "Recap agent", keywords: ["provider", "model"] },
  // TypeSafe
  {
    id: "jev-enabled",
    pane: "jev",
    label: "Use TypeSafe judgments",
    keywords: ["jev", "system one", "sizing", "risk"],
  },
  { id: "jev-api-key", pane: "jev", label: "TypeSafe API key", keywords: ["jev", "key", "token"] },
  { id: "jev-test", pane: "jev", label: "Test TypeSafe connection", keywords: ["jev", "latency"] },
  // Integrations
  ...EXTERNAL_AGENT_PROVIDERS.map((provider) => ({
    id: `integration-${provider}`,
    pane: "integrations" as const,
    label: EXTERNAL_AGENT_PROVIDER_NAMES[provider],
    keywords: ["integration", "mcp", "connect", "plugin", "coding agent"],
  })),
  // Team cache
  {
    id: "cache-enabled",
    pane: "cache",
    label: "Enable team cache",
    keywords: ["remote cache", "share", "gcs", "bucket", "team"],
  },
  { id: "cache-bucket", pane: "cache", label: "Bucket name", keywords: ["gcs", "google cloud"] },
  {
    id: "cache-credentials",
    pane: "cache",
    label: "Google Cloud credentials",
    keywords: ["adc", "gcloud", "sign in"],
  },
  {
    id: "cache-test",
    pane: "cache",
    label: "Test cache connection",
    keywords: ["probe", "bucket"],
  },
  {
    id: "cache-uploads",
    pane: "cache",
    label: "Upload finished walkthroughs",
    keywords: ["push", "share"],
  },
  {
    id: "cache-downloads",
    pane: "cache",
    label: "Hydrate from team cache",
    keywords: ["download", "pull", "reuse"],
  },
  {
    id: "cache-signing-mode",
    pane: "cache",
    label: "Verification mode",
    keywords: ["signing", "signature", "strict", "permissive", "ssh"],
  },
  {
    id: "cache-key-path",
    pane: "cache",
    label: "SSH key path",
    keywords: ["signing", "private key", "ssh"],
  },
  {
    id: "cache-trusted-hosts",
    pane: "cache",
    label: "Trusted signer hosts",
    keywords: ["signing", "github enterprise", "ghe"],
  },
  {
    id: "cache-test-signing",
    pane: "cache",
    label: "Test signing",
    keywords: ["signature", "ssh", "verify"],
  },
  // Updates
  {
    id: "update-channel",
    pane: "updates",
    label: "Release channel",
    keywords: ["nightly", "stable", "beta"],
  },
  {
    id: "update-check",
    pane: "updates",
    label: "Check for updates",
    keywords: ["upgrade", "version"],
  },
  {
    id: "update-build",
    pane: "updates",
    label: "Current build",
    keywords: ["commit", "version", "hash"],
  },
];

export interface SettingsSearchHit {
  entry: SettingsIndexEntry;
  /** Where the query matched inside `entry.label`, for highlighting; null for keyword hits. */
  match: { start: number; end: number } | null;
}

/**
 * Plain substring search over labels, then keywords, then pane titles. Label
 * hits rank first (earliest match first), so typing "wrap" puts "Wrap long
 * lines" above anything that merely lists wrap as a keyword.
 */
export function searchSettings(query: string): SettingsSearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scored: { hit: SettingsSearchHit; score: number }[] = [];
  for (const entry of SETTINGS_INDEX) {
    const at = entry.label.toLowerCase().indexOf(q);
    if (at !== -1) {
      scored.push({ hit: { entry, match: { start: at, end: at + q.length } }, score: 100 - at });
    } else if (entry.keywords.some((k) => k.includes(q))) {
      scored.push({ hit: { entry, match: null }, score: 10 });
    } else if (SETTINGS_PANES[entry.pane].title.toLowerCase().includes(q)) {
      scored.push({ hit: { entry, match: null }, score: 1 });
    }
  }
  return scored.sort((a, b) => b.score - a.score).map((s) => s.hit);
}
