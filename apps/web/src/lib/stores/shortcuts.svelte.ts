import { goto } from "$app/navigation";
import type { Command } from "./command-keys";
import { dispatchCommandKey, registerCommands } from "./commands.svelte";
import { copySelectedPrLink } from "./pr-link.svelte";
import { getSelectedPrId } from "./route.svelte";
import { openSettings, toggleSettings } from "./settingsModal.svelte";
import { openAddRepoDialog, toggleRightPanel, toggleSidebar } from "./sidebar.svelte";
import {
  getStackView,
  mergeOpenStack,
  moveInStack,
  openNextUnreviewedLayer,
  reviewRemainingLayers,
} from "./stack-nav.svelte";
import { setDiffThemePreference, setThemePreference } from "./theme.svelte";

export type PaletteMode = "search" | "command";

let cmdHeld = $state(false);
export function getCmdHeld(): boolean {
  return cmdHeld;
}

let paletteOpen = $state(false);
let paletteMode = $state<PaletteMode>("search");

export function getPaletteOpen(): boolean {
  return paletteOpen;
}

export function getPaletteMode(): PaletteMode {
  return paletteMode;
}

export function setPaletteMode(mode: PaletteMode): void {
  paletteMode = mode;
}

export function closePalette(): void {
  paletteOpen = false;
}

function togglePalette(mode: PaletteMode): void {
  if (paletteOpen && paletteMode === mode) {
    closePalette();
    return;
  }
  paletteMode = mode;
  paletteOpen = true;
}

const onPr = (): boolean => getSelectedPrId() !== null;
const inStack = (): boolean => getStackView() !== null;

/**
 * On a PR, step *back* over its history entry so the shortcut matches the
 * mouse/trackpad back gesture instead of stranding the PR in forward history.
 * SvelteKit stamps `sveltekit:index` on every entry it owns; 0 means nothing
 * is behind us (deep-linked straight in), so go home instead.
 */
function closeView(): void {
  const state = window.history.state as { "sveltekit:index"?: number } | null;
  if (onPr() && (state?.["sveltekit:index"] ?? 0) > 0) window.history.back();
  else void goto("/");
}

const APP_COMMANDS: readonly Command[] = [
  {
    id: "palette:search",
    label: "Search Pull Requests",
    keys: { key: "p" },
    hidden: true,
    run: () => togglePalette("search"),
  },
  {
    id: "palette:commands",
    label: "Command Palette",
    keys: { key: "p", shift: true },
    hidden: true,
    run: () => togglePalette("command"),
  },
  {
    id: "view:close",
    label: "Close Pull Request",
    keys: { key: "w" },
    hidden: true,
    run: closeView,
  },
  {
    id: "theme:light",
    label: "Theme: Light",
    category: "Theme",
    keywords: ["appearance", "light mode"],
    run: () => setThemePreference("light"),
  },
  {
    id: "theme:dark",
    label: "Theme: Dark",
    category: "Theme",
    keywords: ["appearance", "dark mode"],
    run: () => setThemePreference("dark"),
  },
  {
    id: "theme:system",
    label: "Theme: System",
    category: "Theme",
    keywords: ["appearance", "auto", "os"],
    run: () => setThemePreference("system"),
  },
  {
    id: "diff-theme:sync",
    label: "Diff Theme: Sync with App",
    category: "Diff Theme",
    keywords: ["diff", "code", "syntax", "match", "follow"],
    run: () => setDiffThemePreference("sync"),
  },
  {
    id: "diff-theme:light",
    label: "Diff Theme: Light",
    category: "Diff Theme",
    keywords: ["diff", "code", "syntax", "light mode"],
    run: () => setDiffThemePreference("light"),
  },
  {
    id: "diff-theme:dark",
    label: "Diff Theme: Dark",
    category: "Diff Theme",
    keywords: ["diff", "code", "syntax", "dark mode"],
    run: () => setDiffThemePreference("dark"),
  },
  {
    id: "sidebar:toggle",
    label: "Toggle Sidebar",
    category: "Sidebar",
    keys: { key: "b" },
    keywords: ["left", "panel", "hide", "show"],
    run: () => toggleSidebar(),
  },
  {
    id: "panel:toggle",
    label: "Toggle Context Panel",
    category: "Panel",
    keys: { code: "KeyB", alt: true },
    keywords: ["right", "panel", "hide", "show", "context"],
    when: onPr,
    run: () => toggleRightPanel(),
  },
  {
    id: "pr:copy-link",
    label: "Copy PR Link",
    category: "Pull Request",
    keys: { code: "KeyC", shift: true },
    keywords: ["share", "deep link", "url", "clipboard"],
    notInTextFields: true,
    run: () => void copySelectedPrLink(),
  },
  {
    id: "repo:add",
    label: "Add Repository",
    category: "Repository",
    keywords: ["repo", "new", "track", "github", "import"],
    run: () => openAddRepoDialog(),
  },
  {
    id: "settings:open",
    label: "Open Settings",
    category: "Settings",
    keys: { key: "," },
    keywords: ["preferences", "configure", "options"],
    run: () => toggleSettings(),
  },
  {
    id: "settings:ai",
    label: "Settings: AI agent",
    category: "Settings",
    keywords: ["agent", "provider", "model", "claude", "codex", "opencode", "cursor"],
    run: () => openSettings("ai"),
  },
  {
    id: "settings:repositories",
    label: "Settings: Repositories",
    category: "Settings",
    keywords: ["repos", "tracked", "remove"],
    run: () => openSettings("repositories"),
  },
  {
    id: "stack:next",
    label: "Stack: Next Layer",
    category: "Stack",
    keys: { code: "ArrowUp", alt: true },
    keywords: ["up", "above", "layer", "stacked"],
    when: inStack,
    notInTextFields: true,
    ignoreRepeat: true,
    run: () => moveInStack("up"),
  },
  {
    id: "stack:previous",
    label: "Stack: Previous Layer",
    category: "Stack",
    keys: { code: "ArrowDown", alt: true },
    keywords: ["down", "below", "layer", "stacked"],
    when: inStack,
    notInTextFields: true,
    ignoreRepeat: true,
    run: () => moveInStack("down"),
  },
  {
    id: "stack:next-unreviewed",
    label: "Stack: Next Unreviewed Layer",
    category: "Stack",
    keywords: ["review", "walkthrough", "remaining", "todo"],
    when: inStack,
    run: () => openNextUnreviewedLayer(),
  },
  {
    id: "stack:review-all",
    label: "Stack: Review Whole Stack",
    category: "Stack",
    keywords: ["walkthrough", "generate", "remaining", "queue"],
    when: inStack,
    run: () => void reviewRemainingLayers(),
  },
  {
    id: "stack:merge",
    label: "Stack: Merge Stack…",
    category: "Stack",
    keywords: ["merge", "land", "ship"],
    when: inStack,
    run: () => mergeOpenStack(),
  },
];

function handleKeydown(e: KeyboardEvent): void {
  if (e.metaKey && !cmdHeld) cmdHeld = true;
  dispatchCommandKey(e);
}

function handleKeyup(e: KeyboardEvent): void {
  if (e.key === "Meta") cmdHeld = false;
}

function handleBlur(): void {
  cmdHeld = false;
}

export function initShortcuts(): () => void {
  const unregister = registerCommands(APP_COMMANDS);
  // Capture phase, so ⌘ combos work even while an input has focus.
  window.addEventListener("keydown", handleKeydown, { capture: true });
  window.addEventListener("keyup", handleKeyup, { capture: true });
  window.addEventListener("blur", handleBlur);
  return () => {
    unregister();
    window.removeEventListener("keydown", handleKeydown, { capture: true });
    window.removeEventListener("keyup", handleKeyup, { capture: true });
    window.removeEventListener("blur", handleBlur);
  };
}
