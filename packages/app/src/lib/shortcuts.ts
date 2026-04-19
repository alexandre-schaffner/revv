import { useSyncExternalStore, useEffect, useCallback } from "react";

// ── Types ────────────────────────────────────────────────

export interface ShortcutKey {
  mod?: boolean; // Cmd on Mac, Ctrl on other
  shift?: boolean;
  alt?: boolean;
  key: string; // lowercase
}

export interface ShortcutDef {
  id: string;
  label: string;
  keys: ShortcutKey;
  category?: string;
  action: () => void;
  /** Only active when this mode is entered (chord-style) */
  mode?: string;
  /** Only fire when this returns true */
  when?: () => boolean;
}

// ── Platform detection ───────────────────────────────────

const isMac =
  typeof navigator !== "undefined" ? /Mac/.test(navigator.userAgent) : true;

// ── Key display helpers ──────────────────────────────────

/** Returns an array of key symbols/labels for display (e.g. ['⌘', '⇧', 'P']). */
export function formatKeys(keys: ShortcutKey): string[] {
  const parts: string[] = [];
  if (keys.mod) parts.push(isMac ? "⌘" : "Ctrl");
  if (keys.shift) parts.push(isMac ? "⇧" : "Shift");
  if (keys.alt) parts.push(isMac ? "⌥" : "Alt");
  parts.push(
    keys.key.length === 1
      ? keys.key.toUpperCase()
      : keys.key.charAt(0).toUpperCase() + keys.key.slice(1),
  );
  return parts;
}

/** Joined string for compact display (e.g. '⌘⇧P'). */
export function formatKeysString(keys: ShortcutKey): string {
  return formatKeys(keys).join("");
}

// ── Central registry (module-level singleton) ────────────

let registry = new Map<string, ShortcutDef>();
let version = 0;
const listeners = new Set<() => void>();

function notify() {
  version++;
  for (const fn of listeners) fn();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): Map<string, ShortcutDef> {
  return registry;
}

export function registerShortcut(def: ShortcutDef): () => void {
  const next = new Map(registry);
  next.set(def.id, def);
  registry = next;
  notify();
  return () => {
    const next = new Map(registry);
    next.delete(def.id);
    registry = next;
    notify();
  };
}

export function registerShortcuts(defs: ShortcutDef[]): () => void {
  const next = new Map(registry);
  for (const def of defs) next.set(def.id, def);
  registry = next;
  notify();
  return () => {
    const next = new Map(registry);
    for (const def of defs) next.delete(def.id);
    registry = next;
    notify();
  };
}

export function getShortcut(id: string): ShortcutDef | undefined {
  return registry.get(id);
}

export function getAllShortcuts(): ShortcutDef[] {
  return [...registry.values()];
}

// ── Mode state (chord leader) ────────────────────────────
//
// Mode activates immediately on the leader key (e.g. ⌘R) and stays
// active while Cmd/Ctrl is held. Releasing the modifier exits the mode.
// Click-activated mode (no modifier held) toggles on/off.

let activeMode: string | null = null;

export function enterMode(mode: string): void {
  activeMode = mode;
  notify();
}

export function exitMode(): void {
  if (activeMode === null) return;
  activeMode = null;
  notify();
}

export function toggleMode(mode: string): void {
  if (activeMode === mode) exitMode();
  else enterMode(mode);
}

export function getActiveMode(): string | null {
  return activeMode;
}

/** Get all shortcuts registered for a specific mode. */
export function getModeShortcuts(mode: string): ShortcutDef[] {
  const result: ShortcutDef[] = [];
  for (const def of registry.values()) {
    if (def.mode === mode) result.push(def);
  }
  return result;
}

// ── Press feedback ───────────────────────────────────────

let pressedId: string | null = null;
let pressTimer: ReturnType<typeof setTimeout> | null = null;

const PRESS_DURATION_MS = 120;

function flashPressed(id: string) {
  pressedId = id;
  if (pressTimer !== null) clearTimeout(pressTimer);
  pressTimer = setTimeout(() => {
    pressedId = null;
    pressTimer = null;
    notify();
  }, PRESS_DURATION_MS);
  notify();
}

export function getPressedId(): string | null {
  return pressedId;
}

// ── Key matching ─────────────────────────────────────────

function matchesEvent(keys: ShortcutKey, e: KeyboardEvent): boolean {
  return (
    !!keys.mod === e.metaKey &&
    !!keys.shift === e.shiftKey &&
    !!keys.alt === e.altKey &&
    e.key.toLowerCase() === keys.key
  );
}

// ── Global keydown handler ───────────────────────────────

function isTextInput(target: EventTarget | null): boolean {
  if (target instanceof HTMLInputElement) return true;
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  return false;
}

function handleKeydown(e: KeyboardEvent): void {
  // Escape exits any active mode
  if (e.key === "Escape" && activeMode !== null) {
    e.preventDefault();
    exitMode();
    return;
  }

  const inInput = isTextInput(e.target);

  // First pass: mode-specific shortcuts (only when mode is active)
  if (activeMode !== null) {
    for (const def of registry.values()) {
      if (def.mode !== activeMode) continue;
      if (!matchesEvent(def.keys, e)) continue;
      if (!def.keys.mod && inInput) continue;
      if (def.when && !def.when()) continue;
      e.preventDefault();
      e.stopPropagation();
      flashPressed(def.id);
      def.action();
      return;
    }
  }

  // Second pass: global shortcuts (no mode restriction)
  for (const def of registry.values()) {
    if (def.mode) continue;
    if (!matchesEvent(def.keys, e)) continue;
    if (!def.keys.mod && inInput) continue;
    if (def.when && !def.when()) continue;
    e.preventDefault();
    e.stopPropagation();
    flashPressed(def.id);
    def.action();
    return;
  }
}

function handleKeyup(e: KeyboardEvent): void {
  // Release of modifier key exits active mode
  if (activeMode !== null && (e.key === "Meta" || e.key === "Control")) {
    exitMode();
  }
}

let listenerAttached = false;

/** Attach global keyboard listeners. Call once at app root. Returns cleanup. */
export function initShortcuts(): () => void {
  if (listenerAttached) return () => {};
  listenerAttached = true;
  window.addEventListener("keydown", handleKeydown, { capture: true });
  window.addEventListener("keyup", handleKeyup, { capture: true });
  return () => {
    window.removeEventListener("keydown", handleKeydown, { capture: true });
    window.removeEventListener("keyup", handleKeyup, { capture: true });
    listenerAttached = false;
  };
}

// ── React hooks ──────────────────────────────────────────

/** Subscribe to the shortcut registry. Returns the current Map. */
export function useShortcutRegistry(): Map<string, ShortcutDef> {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Look up a single shortcut by ID (reactive). */
export function useShortcut(id: string): ShortcutDef | undefined {
  const reg = useShortcutRegistry();
  return reg.get(id);
}

// Stable snapshot functions for useSyncExternalStore
function getActiveModeSnapshot(): string | null {
  return activeMode;
}
function getActiveModeServerSnapshot(): null {
  return null;
}

/** Reactive active mode (null during pending phase — only reflects visible state). */
export function useActiveMode(): string | null {
  return useSyncExternalStore(subscribe, getActiveModeSnapshot, getActiveModeServerSnapshot);
}

/** All shortcuts for a given mode (reactive). */
export function useModeShortcuts(mode: string): ShortcutDef[] {
  const reg = useShortcutRegistry();
  const result: ShortcutDef[] = [];
  for (const def of reg.values()) {
    if (def.mode === mode) result.push(def);
  }
  return result;
}

function getPressedServerSnapshot(): boolean {
  return false;
}

/** Returns true briefly (120ms) when the given shortcut fires. */
export function useShortcutPressed(id: string): boolean {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const getSnapshot = useCallback(() => pressedId === id, [id]);
  return useSyncExternalStore(subscribe, getSnapshot, getPressedServerSnapshot);
}

/**
 * Register shortcuts for a block/component. Automatically unregisters on unmount.
 */
export function useRegisterShortcuts(defs: ShortcutDef[]): void {
  useEffect(() => {
    return registerShortcuts(defs);
    // Re-register when the serialized keys/ids change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(defs.map((d) => d.id))]);
}

/**
 * Get the formatted key parts for a registered shortcut (for rendering in Kbd).
 * Returns undefined if the shortcut isn't registered.
 */
export function useShortcutKeys(id: string): string[] | undefined {
  const def = useShortcut(id);
  return def ? formatKeys(def.keys) : undefined;
}
