import type { ThemePreference } from "@revv/shared";
import { untrack } from "svelte";

export type { ThemePreference };

type DiffThemePreference = "sync" | "light" | "dark";

const THEME_KEY = "revv-theme";
const DIFF_THEME_KEY = "revv-diff-theme";

// ── State ────────────────────────────────────────────────────────────────────

let preference = $state<ThemePreference>(readStored(THEME_KEY, "system"));
let diffPreference = $state<DiffThemePreference>(readStored(DIFF_THEME_KEY, "sync"));
let _resolved = $derived<"light" | "dark">(resolve(preference));

function readStored<T extends string>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  const v = localStorage.getItem(key);
  return v === "light" || v === "dark" ? (v as T) : fallback;
}

function resolve(pref: ThemePreference): "light" | "dark" {
  if (pref === "dark") return "dark";
  if (pref === "light") return "light";
  if (typeof window === "undefined") return "light";
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

// ── DOM ──────────────────────────────────────────────────────────────────────

/** Class held on <html> only for the instant of the swap. See `apply()`. */
const SWAP_CLASS = "theme-switching";

/** Pending handle for dropping {@link SWAP_CLASS}, so rapid toggling doesn't
 *  strand it on (each swap re-arms rather than stacking add/remove pairs). */
let swapRelease: number | null = null;

/** Toggle .dark on <html> and set colorScheme. Synchronous — the browser
 *  batches both writes into a single style recalc, so there is no flash.
 *
 *  The swap is wrapped in `.theme-switching`, which zeroes every transition
 *  duration and delay in the document (see app.css). Without it a theme change
 *  isn't one repaint, it's a staggered crossfade: ~450 elements on a typical
 *  route transition `color` / `background` / `border-color`, at four different
 *  token durations plus Tailwind's own 150ms `transition-colors` — while
 *  untransitioned elements flip immediately. The app arrives in five waves over
 *  220ms, which reads as parts of the UI switching before others.
 *
 *  Suppression, not a shared duration. Giving every component the same
 *  transition was tried and rejected — see the app.css block for why it is
 *  uniform on paper but not smooth in practice.
 *
 *  Note: we intentionally avoid the View Transition API here. Its overlay
 *  compositing layers break backdrop-filter on glass elements (they lose
 *  their blur and go transparent during the transition).
 *
 *  Note also: do NOT drive the *native* window theme from here
 *  (`getCurrentWindow().setTheme(...)`). It looks like the missing piece — the
 *  window's own appearance governs the traffic-light overlay region and the
 *  background the compositor paints during a live resize, and Tauri leaves it
 *  on the OS preference. But an NSWindow appearance change costs 20–95ms of
 *  main thread and forces a second, full webview repaint a beat after the CSS
 *  one, which reads as lag. Worse, it is circular: the webview's
 *  `prefers-color-scheme` reports the *window's* appearance, not the OS's, so
 *  forcing it overwrites the only signal `resolve()` and the mq listener below
 *  have for what "system" means. Switching into system mode then renders the
 *  previous forced value, waits for the IPC to land, and re-renders. */
function apply(pref: ThemePreference): void {
  const isDark =
    pref === "dark" || (pref === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  const root = document.documentElement;

  root.classList.add(SWAP_CLASS);
  root.classList.toggle("dark", isDark);
  root.style.colorScheme = isDark ? "dark" : "light";

  // Drop the class two frames out rather than forcing a synchronous flush with
  // a layout read. Both get an atomic swap, but a forced read costs a full
  // layout inside the click handler and the app pays for it twice — measured at
  // 70ms of blocked main thread, versus ~1ms here. The frame the browser was
  // going to render anyway does the same work, and the restoring recalc only
  // touches transition-duration, so it neither lays out nor paints.
  //
  // Two frames, not one: an rAF callback runs *before* its frame's style
  // recalc, so restoring after a single frame would put the color change and
  // the live durations in the same recalc — which is precisely the transition
  // we're suppressing.
  if (swapRelease !== null) cancelAnimationFrame(swapRelease);
  swapRelease = requestAnimationFrame(() => {
    swapRelease = requestAnimationFrame(() => {
      swapRelease = null;
      root.classList.remove(SWAP_CLASS);
    });
  });

  _resolved = isDark ? "dark" : "light";
}

/** Sync the data-diff-theme attribute on <html> so the CSS rules in app.css
 *  can force Pierre's color-scheme for explicit light/dark overrides.
 *  When 'sync', the attribute is removed and Pierre inherits from the document. */
function applyDiffTheme(pref: DiffThemePreference): void {
  if (pref === "sync") {
    delete document.documentElement.dataset.diffTheme;
  } else {
    document.documentElement.dataset.diffTheme = pref;
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Call once from root layout. Returns cleanup. Untracked — must never re-run. */
export function initTheme(): () => void {
  untrack(() => {
    apply(preference);
    applyDiffTheme(diffPreference);
  });

  const mq = matchMedia("(prefers-color-scheme: dark)");
  const onChange = () =>
    untrack(() => {
      if (preference === "system") {
        apply("system");
      }
    });
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

export function getThemePreference(): ThemePreference {
  return preference;
}

export function getResolvedTheme(): "light" | "dark" {
  return _resolved;
}

export function setThemePreference(pref: ThemePreference): void {
  preference = pref;
  localStorage.setItem(THEME_KEY, pref);
  apply(pref);
}

export function setDiffThemePreference(pref: DiffThemePreference): void {
  diffPreference = pref;
  localStorage.setItem(DIFF_THEME_KEY, pref);
  applyDiffTheme(pref);
}
