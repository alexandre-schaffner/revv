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

/** Toggle .dark on <html> and set colorScheme. Synchronous — the browser
 *  batches both writes into a single style recalc, so there is no flash.
 *
 *  Note: we intentionally avoid the View Transition API here. Its overlay
 *  compositing layers break backdrop-filter on glass elements (they lose
 *  their blur and go transparent during the transition). */
function apply(pref: ThemePreference): void {
  const isDark =
    pref === "dark" || (pref === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", isDark);
  document.documentElement.style.colorScheme = isDark ? "dark" : "light";
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
