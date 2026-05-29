import { untrack } from "svelte";

export type AccentPreset = "teal" | "amber" | "rose" | "sage" | "indigo";

export const ACCENT_PRESETS: {
  value: AccentPreset;
  label: string;
  /** Light-theme swatch color shown in the picker regardless of resolved theme. */
  swatch: string;
}[] = [
  { value: "teal",   label: "Teal",   swatch: "oklch(48% 0.08 195)" },
  { value: "amber",  label: "Amber",  swatch: "oklch(52% 0.12 62)"  },
  { value: "rose",   label: "Rose",   swatch: "oklch(48% 0.10 340)" },
  { value: "sage",   label: "Sage",   swatch: "oklch(46% 0.09 155)" },
  { value: "indigo", label: "Indigo", swatch: "oklch(44% 0.13 265)" },
];

const ACCENT_KEY = "revv-accent";

const VALID: Set<string> = new Set(ACCENT_PRESETS.map((p) => p.value));

// ── State ────────────────────────────────────────────────────────────────────

let preference = $state<AccentPreset>(readStored());

function readStored(): AccentPreset {
  if (typeof window === "undefined") return "teal";
  const v = localStorage.getItem(ACCENT_KEY);
  return v && VALID.has(v) ? (v as AccentPreset) : "teal";
}

// ── DOM ──────────────────────────────────────────────────────────────────────

function apply(preset: AccentPreset): void {
  document.documentElement.dataset.accent = preset;
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Call once from root layout. No cleanup needed (no media-query listener). */
export function initAccent(): void {
  untrack(() => apply(preference));
}

export function getAccent(): AccentPreset {
  return preference;
}

export function setAccent(preset: AccentPreset): void {
  preference = preset;
  localStorage.setItem(ACCENT_KEY, preset);
  apply(preset);
}
