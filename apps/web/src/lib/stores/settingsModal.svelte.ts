export type SettingsSectionId =
  | "account"
  | "ai"
  | "recap"
  | "cache"
  | "preferences"
  | "onboarding"
  | "updates"
  | "danger";

let open = $state(false);
let targetSection = $state<SettingsSectionId | null>(null);

export function getSettingsOpen(): boolean {
  return open;
}

export function getSettingsTargetSection(): SettingsSectionId | null {
  return targetSection;
}

export function clearSettingsTargetSection(): void {
  targetSection = null;
}

export function openSettings(section?: SettingsSectionId): void {
  if (section) targetSection = section;
  open = true;
}

export function closeSettings(): void {
  open = false;
}

export function toggleSettings(): void {
  open = !open;
}
