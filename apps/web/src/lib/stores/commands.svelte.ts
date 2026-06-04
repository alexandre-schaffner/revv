import { fuzzyScore } from "$lib/utils/fuzzy";
import {
  collapseAllRepoGroups,
  openAddRepoDialog,
  toggleRightPanel,
  toggleSidebar,
} from "./sidebar.svelte";
import { setDiffThemePreference, setThemePreference } from "./theme.svelte";

// Re-export so existing consumers (CommandPalette) keep importing from here.
export { fuzzyScore };

export interface Command {
  id: string;
  label: string;
  category?: string;
  shortcut?: string;
  keywords?: string[];
  action: () => void;
}

const commands = $state<Command[]>([
  {
    id: "theme:light",
    label: "Theme: Light",
    category: "Theme",
    keywords: ["appearance", "light mode"],
    action: () => setThemePreference("light"),
  },
  {
    id: "theme:dark",
    label: "Theme: Dark",
    category: "Theme",
    keywords: ["appearance", "dark mode"],
    action: () => setThemePreference("dark"),
  },
  {
    id: "theme:system",
    label: "Theme: System",
    category: "Theme",
    keywords: ["appearance", "auto", "os"],
    action: () => setThemePreference("system"),
  },
  {
    id: "diff-theme:sync",
    label: "Diff Theme: Sync with App",
    category: "Diff Theme",
    keywords: ["diff", "code", "syntax", "match", "follow"],
    action: () => setDiffThemePreference("sync"),
  },
  {
    id: "diff-theme:light",
    label: "Diff Theme: Light",
    category: "Diff Theme",
    keywords: ["diff", "code", "syntax", "light mode"],
    action: () => setDiffThemePreference("light"),
  },
  {
    id: "diff-theme:dark",
    label: "Diff Theme: Dark",
    category: "Diff Theme",
    keywords: ["diff", "code", "syntax", "dark mode"],
    action: () => setDiffThemePreference("dark"),
  },
  {
    id: "sidebar:collapse-all",
    label: "Collapse All Repositories",
    category: "Sidebar",
    keywords: ["fold", "minimize", "repos"],
    action: () => collapseAllRepoGroups(),
  },
  {
    id: "sidebar:toggle",
    label: "Toggle Sidebar",
    category: "Sidebar",
    shortcut: "\u2318B",
    keywords: ["left", "panel", "hide", "show"],
    action: () => toggleSidebar(),
  },
  {
    id: "panel:toggle",
    label: "Toggle Context Panel",
    category: "Panel",
    shortcut: "\u2318\u2325B",
    keywords: ["right", "panel", "hide", "show", "context"],
    action: () => toggleRightPanel(),
  },
  {
    id: "repo:add",
    label: "Add Repository",
    category: "Repository",
    keywords: ["repo", "new", "track", "github", "import"],
    action: () => openAddRepoDialog(),
  },
]);

let query = $state("");

// ── Fuzzy matching ───────────────────────────────────────
// `fuzzyScore` lives in `$lib/utils/fuzzy` and is re-exported above for
// backwards compatibility with existing imports.

function scoreCommand(cmd: Command, q: string): number {
  let best = fuzzyScore(q, cmd.label);

  if (cmd.keywords) {
    for (const kw of cmd.keywords) {
      best = Math.max(best, fuzzyScore(q, kw));
    }
  }

  if (cmd.category) {
    best = Math.max(best, fuzzyScore(q, cmd.category));
  }

  return best;
}

const filteredCommands = $derived.by(() => {
  const q = query.trim();
  if (q.length === 0) return commands;

  return commands
    .map((cmd) => ({ cmd, score: scoreCommand(cmd, q) }))
    .filter((r) => r.score >= 0)
    .sort((a, b) => b.score - a.score)
    .map((r) => r.cmd);
});

// ── Exports ──────────────────────────────────────────────

export function getFilteredCommands(): Command[] {
  return filteredCommands;
}

export function setQuery(q: string): void {
  query = q;
}

export function resetQuery(): void {
  query = "";
}
