// xterm paints to a canvas, so it needs literal colors and fonts rather than
// `var()`; these helpers read them off resolved CSS tokens. xterm is imported on
// demand because it touches the DOM at import time (no SSR/prerender).

import type { FitAddon } from "@xterm/addon-fit";
import type { ITerminalOptions, ITheme, Terminal } from "@xterm/xterm";

export interface XtermInk {
  readonly foreground: string;
  readonly muted: string;
  readonly dim: string;
  readonly accent: string;
  readonly danger: string;
  readonly heading: string;
  readonly cursor: string;
  readonly cursorAccent?: string;
  readonly selection: string;
}

/** Reads a custom property off `el`, or `fallback` when it is unset. */
export function cssTokens(el: HTMLElement): (name: string, fallback: string) => string {
  const cs = getComputedStyle(el);
  return (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
}

export function monoFont(el: HTMLElement): string {
  return cssTokens(el)("--font-mono", '"JetBrains Mono", "Fira Code", monospace');
}

/**
 * Maps an app palette onto the 16 ANSI slots, so CLI colors read on the app's
 * surfaces instead of xterm's default bright palette.
 */
export function xtermTheme(ink: XtermInk): ITheme {
  return {
    background: "#00000000",
    foreground: ink.foreground,
    cursor: ink.cursor,
    ...(ink.cursorAccent ? { cursorAccent: ink.cursorAccent } : {}),
    selectionBackground: ink.selection,
    black: ink.dim,
    red: ink.danger,
    green: ink.accent,
    yellow: ink.accent,
    blue: ink.muted,
    magenta: ink.accent,
    cyan: ink.muted,
    white: ink.foreground,
    brightBlack: ink.muted,
    brightRed: ink.danger,
    brightGreen: ink.accent,
    brightYellow: ink.accent,
    brightBlue: ink.muted,
    brightMagenta: ink.accent,
    brightCyan: ink.muted,
    brightWhite: ink.heading,
  };
}

/** Opens a terminal with a fit addon in `container`. */
export async function openXterm(
  container: HTMLElement,
  options: ITerminalOptions,
): Promise<{ term: Terminal; fit: FitAddon }> {
  const [{ Terminal }, { FitAddon }] = await Promise.all([
    import("@xterm/xterm"),
    import("@xterm/addon-fit"),
  ]);
  const term = new Terminal({
    allowTransparency: true,
    fontFamily: monoFont(container),
    ...options,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(container);
  return { term, fit };
}
