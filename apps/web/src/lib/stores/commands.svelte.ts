import { onDestroy } from "svelte";
import { isTextEditingKeyTarget } from "$lib/utils";
import { fuzzyScore } from "$lib/utils/fuzzy";
import {
  type Command,
  findBareCommand,
  findBoundCommand,
  isAvailable,
  shortcutGlyphs,
  startsChord,
} from "./command-keys";

// Later registrations shadow earlier ones on the same keys, so a page can
// take over a binding for as long as it is mounted.
let registered = $state.raw<readonly Command[]>([]);

export function registerCommands(commands: readonly Command[]): () => void {
  registered = [...registered, ...commands];
  return () => {
    registered = registered.filter((cmd) => !commands.includes(cmd));
  };
}

export function useCommands(commands: readonly Command[]): void {
  onDestroy(registerCommands(commands));
}

/** The glyphs of a registered command's binding, for UI hints; empty when it has none. */
export function commandShortcut(id: string): string[] {
  const keys = registered.find((cmd) => cmd.id === id)?.keys;
  return keys ? shortcutGlyphs(keys) : [];
}

/** Runs the command bound to a ⌘ combo. Returns whether the event was taken. */
export function dispatchCommandKey(e: KeyboardEvent): boolean {
  const cmd = findBoundCommand(registered, e);
  if (!cmd) return false;
  if (cmd.notInTextFields && isTextEditingKeyTarget(e)) return false;
  e.preventDefault();
  e.stopPropagation();
  if (!(cmd.ignoreRepeat && e.repeat)) cmd.run();
  return true;
}

/** How long a chord's first key waits for its second. */
const CHORD_MS = 300;
let chordPrefix: string | null = null;
let chordTimer: ReturnType<typeof setTimeout> | undefined;

function clearChord(): void {
  chordPrefix = null;
  clearTimeout(chordTimer);
}

/**
 * Runs the command bound to a bare key (see `BareBinding`). Call after the
 * event has reached the focused widget: a key it took (`defaultPrevented`) is
 * left alone. Any key ends a pending chord. Returns whether the event was taken.
 */
export function dispatchBareKey(e: KeyboardEvent): boolean {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return false;
  if (isTextEditingKeyTarget(e)) return false;
  const prefix = chordPrefix;
  clearChord();
  const cmd = findBareCommand(registered, e, prefix);
  if (cmd) {
    e.preventDefault();
    cmd.run();
    return true;
  }
  if (!startsChord(registered, e)) return false;
  e.preventDefault();
  chordPrefix = e.key;
  chordTimer = setTimeout(clearChord, CHORD_MS);
  return true;
}

let query = $state("");

function scoreCommand(cmd: Command, q: string): number {
  let best = fuzzyScore(q, cmd.label);
  for (const kw of cmd.keywords ?? []) best = Math.max(best, fuzzyScore(q, kw));
  if (cmd.category) best = Math.max(best, fuzzyScore(q, cmd.category));
  return best;
}

const filteredCommands = $derived.by(() => {
  const offered = registered.filter((cmd) => !cmd.hidden && isAvailable(cmd));
  const q = query.trim();
  if (q.length === 0) return offered;
  return offered
    .map((cmd) => ({ cmd, score: scoreCommand(cmd, q) }))
    .filter((r) => r.score >= 0)
    .sort((a, b) => b.score - a.score)
    .map((r) => r.cmd);
});

export function getFilteredCommands(): readonly Command[] {
  return filteredCommands;
}

export function setQuery(q: string): void {
  query = q;
}

export function resetQuery(): void {
  query = "";
}
