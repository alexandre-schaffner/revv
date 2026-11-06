import {
  getThemePreference,
  setThemePreference,
  type ThemePreference,
} from "$lib/stores/theme.svelte";

const NEXT: Record<ThemePreference, ThemePreference> = {
  system: "light",
  light: "dark",
  dark: "system",
};

const LABEL: Record<ThemePreference, string> = {
  system: "System theme",
  light: "Light theme",
  dark: "Dark theme",
};

/** The theme toggle's order: system → light → dark → system. */
export function cycleThemePreference(): void {
  setThemePreference(NEXT[getThemePreference()]);
}

/** Accessible name for the theme toggle in its current state. */
export function themePreferenceLabel(): string {
  return LABEL[getThemePreference()];
}
