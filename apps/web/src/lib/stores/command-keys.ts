/**
 * A ⌘ binding. `key` matches `KeyboardEvent.key` (case-insensitive), `code`
 * matches the physical key — use `code` when Shift or Option is part of the
 * binding, because on macOS they rewrite the produced character (Option+B
 * yields "∫"). Shift and Option must match exactly.
 */
export interface KeyBinding {
  key?: string;
  code?: string;
  shift?: boolean;
  alt?: boolean;
}

export interface Command {
  id: string;
  label: string;
  category?: string;
  keywords?: string[];
  keys?: KeyBinding;
  /** Offered in the palette and bound to its keys only while this is true. */
  when?: () => boolean;
  /** Bound to its keys but left out of the palette. */
  hidden?: boolean;
  notInTextFields?: boolean;
  ignoreRepeat?: boolean;
  run: () => void;
}

export function isAvailable(cmd: Command): boolean {
  return cmd.when?.() ?? true;
}

function matches(keys: KeyBinding, e: KeyboardEvent): boolean {
  if (!e.metaKey) return false;
  if (e.shiftKey !== (keys.shift ?? false) || e.altKey !== (keys.alt ?? false)) return false;
  if (keys.code !== undefined) return e.code === keys.code;
  return keys.key !== undefined && e.key.toLowerCase() === keys.key;
}

/** The available command bound to this event's ⌘ combo; the latest registered wins. */
export function findBoundCommand(
  commands: readonly Command[],
  e: KeyboardEvent,
): Command | undefined {
  for (let i = commands.length - 1; i >= 0; i--) {
    const cmd = commands[i];
    if (cmd?.keys && matches(cmd.keys, e) && isAvailable(cmd)) return cmd;
  }
  return undefined;
}

const CODE_GLYPHS: Record<string, string> = {
  ArrowUp: "\u2191",
  ArrowDown: "\u2193",
  ArrowLeft: "\u2190",
  ArrowRight: "\u2192",
};

/** macOS-order modifier glyphs (⌥⇧⌘) plus the key, e.g. "⇧⌘C". */
export function shortcutLabel(keys: KeyBinding): string {
  const base = keys.code
    ? (CODE_GLYPHS[keys.code] ?? keys.code.replace(/^(Key|Digit)/, ""))
    : (keys.key ?? "").toUpperCase();
  return `${keys.alt ? "\u2325" : ""}${keys.shift ? "\u21e7" : ""}\u2318${base}`;
}
