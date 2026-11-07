/** The settings sections, by the id each pane declares. */
export type SettingsSectionId =
  | "general"
  | "account"
  | "repositories"
  | "ai"
  | "recap"
  | "jev"
  | "integrations"
  | "cache"
  | "updates";

let open = $state(false);
let section = $state<SettingsSectionId>("general");

export function getSettingsOpen(): boolean {
  return open;
}

export function getSettingsSection(): SettingsSectionId {
  return section;
}

export function selectSettingsSection(id: SettingsSectionId): void {
  section = id;
}

/** Opens on `target`, or switches the open modal to it. */
export function openSettings(target: SettingsSectionId): void {
  section = target;
  open = true;
}

export function closeSettings(): void {
  open = false;
}

export function toggleSettings(): void {
  if (open) closeSettings();
  else openSettings("general");
}
