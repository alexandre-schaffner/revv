/**
 * A ⌘ binding. `key` matches `KeyboardEvent.key` (case-insensitive), `code`
 * matches the physical key — use `code` when Shift or Option is part of the
 * binding, because on macOS they rewrite the produced character (Option+B
 * yields "∫"). Shift and Option must match exactly.
 */
export interface ModBinding {
  key?: string;
  code?: string;
  shift?: boolean;
  alt?: boolean;
}

/**
 * Keys typed without ⌘, Ctrl or Option, outside text fields, and only when no
 * focused widget took the event first. Each of `bare` matches
 * `KeyboardEvent.key` exactly, so "G" is Shift+G. With `after`, the binding is
 * a chord: the key typed right after `after` (vim's "gg").
 */
export interface BareBinding {
  bare: readonly string[];
  after?: string;
}

export type KeyBinding = ModBinding | BareBinding;

export interface Command {
  id: string;
  label: string;
  category?: string;
  keywords?: string[];
  keys?: KeyBinding;
  /** Offered in the palette and bound to its keys only while this is true. */
  when?: () => boolean;
  /** Bound to its keys only while the key event comes from inside this element. */
  within?: () => Element | null | undefined;
  /** Bound to its keys but left out of the palette. */
  hidden?: boolean;
  notInTextFields?: boolean;
  ignoreRepeat?: boolean;
  run: () => void;
}

export function isAvailable(cmd: Command): boolean {
  return cmd.when?.() ?? true;
}

function isBare(keys: KeyBinding): keys is BareBinding {
  return "bare" in keys;
}

function matches(keys: KeyBinding, e: KeyboardEvent): boolean {
  if (isBare(keys) || !e.metaKey) return false;
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

function inScope(cmd: Command, e: KeyboardEvent): boolean {
  if (!cmd.within) return true;
  const scope = cmd.within();
  return scope != null && e.target instanceof Node && scope.contains(e.target);
}

function bareCommand(
  commands: readonly Command[],
  e: KeyboardEvent,
  after: string | undefined,
): Command | undefined {
  for (let i = commands.length - 1; i >= 0; i--) {
    const cmd = commands[i];
    const keys = cmd?.keys;
    if (!cmd || !keys || !isBare(keys) || keys.after !== after) continue;
    if (keys.bare.includes(e.key) && isAvailable(cmd) && inScope(cmd, e)) return cmd;
  }
  return undefined;
}

/**
 * The available command bound to this bare key; the latest registered wins.
 * Following `prefix` (the chord's first key), a chord completing it wins over
 * a plain binding of the same key.
 */
export function findBareCommand(
  commands: readonly Command[],
  e: KeyboardEvent,
  prefix: string | null,
): Command | undefined {
  return (
    (prefix !== null ? bareCommand(commands, e, prefix) : undefined) ??
    bareCommand(commands, e, undefined)
  );
}

/** Whether this key opens an available chord. */
export function startsChord(commands: readonly Command[], e: KeyboardEvent): boolean {
  return commands.some(
    (cmd) =>
      cmd.keys !== undefined &&
      isBare(cmd.keys) &&
      cmd.keys.after === e.key &&
      isAvailable(cmd) &&
      inScope(cmd, e),
  );
}

const CODE_GLYPHS: Record<string, string> = {
  ArrowUp: "\u2191",
  ArrowDown: "\u2193",
  ArrowLeft: "\u2190",
  ArrowRight: "\u2192",
};

/** macOS-order modifier glyphs (⌥⇧⌘) then the key, e.g. ["⇧", "⌘", "C"]; a bare key as typed. */
export function shortcutGlyphs(keys: KeyBinding): string[] {
  if (isBare(keys)) return [...(keys.after !== undefined ? [keys.after] : []), keys.bare[0] ?? ""];
  const base = keys.code
    ? (CODE_GLYPHS[keys.code] ?? keys.code.replace(/^(Key|Digit)/, ""))
    : (keys.key ?? "").toUpperCase();
  return [...(keys.alt ? ["\u2325"] : []), ...(keys.shift ? ["\u21e7"] : []), "\u2318", base];
}

/** e.g. "⇧⌘C". */
export function shortcutLabel(keys: KeyBinding): string {
  return shortcutGlyphs(keys).join("");
}
