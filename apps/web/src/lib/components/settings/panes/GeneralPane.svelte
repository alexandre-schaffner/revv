<script module lang="ts">
import GearSix from "phosphor-svelte/lib/GearSix";
import { defineSettingsPane } from "../settings-panes";

export const pane = defineSettingsPane({
  id: "general",
  title: "General",
  description: "Appearance, how diffs render, and how often Revv checks GitHub.",
  icon: GearSix,
  rows: {
    theme: { label: "Theme", keywords: ["appearance", "dark", "light", "mode"] },
    diffTheme: { label: "Diff theme", keywords: ["syntax", "code", "colors", "dark", "light"] },
    diffLayout: {
      label: "Default diff layout",
      keywords: ["split", "unified", "side by side", "view"],
    },
    diffWrap: { label: "Wrap long lines", keywords: ["wrap", "soft wrap", "overflow", "scroll"] },
    syncInterval: {
      label: "Refresh interval",
      keywords: ["sync", "poll", "fetch", "github", "minutes"],
    },
    replayOnboarding: {
      label: "Replay onboarding",
      keywords: ["setup", "welcome", "tutorial", "reset"],
    },
  },
});
</script>

<script lang="ts">
import ArrowCounterClockwise from "phosphor-svelte/lib/ArrowCounterClockwise";
import Columns from "phosphor-svelte/lib/Columns";
import Desktop from "phosphor-svelte/lib/Desktop";
import Moon from "phosphor-svelte/lib/Moon";
import Rows from "phosphor-svelte/lib/Rows";
import Spinner from "phosphor-svelte/lib/Spinner";
import Sun from "phosphor-svelte/lib/Sun";
import { goto } from "$app/navigation";
import { Button } from "$lib/components/ui/button/index.js";
import { SegmentedControl, type SegmentedOption } from "$lib/components/ui/segmented-control";
import * as Select from "$lib/components/ui/select";
import { Switch } from "$lib/components/ui/switch";
import { resetOnboarding } from "$lib/stores/auth.svelte";
import { getDiffWrap, setDiffWrap } from "$lib/stores/diff-prefs.svelte";
import { getDiffMode, setDiffMode } from "$lib/stores/diff-prefs.svelte";
import { getSettings, updateSettings } from "$lib/stores/settings.svelte";
import { closeSettings } from "$lib/stores/settingsModal.svelte";
import {
  type DiffThemePreference,
  getDiffThemePreference,
  getThemePreference,
  setDiffThemePreference,
  setThemePreference,
  type ThemePreference,
} from "$lib/stores/theme.svelte";
import SettingsGroup from "../primitives/SettingsGroup.svelte";
import SettingsPane from "../primitives/SettingsPane.svelte";
import SettingsRow from "../primitives/SettingsRow.svelte";

const themeOptions: SegmentedOption<ThemePreference>[] = [
  { value: "system", label: "System", icon: Desktop },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
];

const diffThemeOptions: SegmentedOption<DiffThemePreference>[] = [
  { value: "sync", label: "Match app" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

const layoutOptions: SegmentedOption<"unified" | "split">[] = [
  { value: "unified", label: "Unified", icon: Rows },
  { value: "split", label: "Split", icon: Columns },
];

const intervalOptions = [
  { label: "Off", value: 0 },
  { label: "Every minute", value: 1 },
  { label: "Every 5 minutes", value: 5 },
  { label: "Every 10 minutes", value: 10 },
  { label: "Every 15 minutes", value: 15 },
  { label: "Every 30 minutes", value: 30 },
];

const interval = $derived(getSettings().autoFetchInterval);
const intervalLabel = $derived(
  intervalOptions.find((o) => o.value === interval)?.label ?? `Every ${interval} minutes`,
);

function handleIntervalChange(value: string | undefined): void {
  if (!value) return;
  const minutes = Number(value);
  void updateSettings({ autoFetchInterval: minutes });
}

let replaying = $state(false);

async function handleReplayOnboarding(): Promise<void> {
  replaying = true;
  try {
    await resetOnboarding();
    closeSettings();
    await goto("/");
  } finally {
    replaying = false;
  }
}
</script>

<SettingsPane {pane}>
	<SettingsGroup heading="Appearance">
		<SettingsRow row={pane.rows.theme} label="Theme" hint="Follow the system, or pin light or dark.">
			{#snippet control()}
				<SegmentedControl
					aria-label="Theme"
					options={themeOptions}
					value={getThemePreference()}
					onValueChange={setThemePreference}
				/>
			{/snippet}
		</SettingsRow>
		<SettingsRow
			row={pane.rows.diffTheme}
			label="Diff theme"
			hint="Syntax colors in diffs. Pin one to read light code in a dark app, or the reverse."
		>
			{#snippet control()}
				<SegmentedControl
					aria-label="Diff theme"
					options={diffThemeOptions}
					value={getDiffThemePreference()}
					onValueChange={setDiffThemePreference}
				/>
			{/snippet}
		</SettingsRow>
	</SettingsGroup>

	<SettingsGroup heading="Diffs">
		<SettingsRow
			row={pane.rows.diffLayout}
			label="Default layout"
			hint="Also changes when you switch layouts from a review."
		>
			{#snippet control()}
				<SegmentedControl
					aria-label="Default diff layout"
					options={layoutOptions}
					value={getDiffMode()}
					onValueChange={setDiffMode}
				/>
			{/snippet}
		</SettingsRow>
		<SettingsRow
			row={pane.rows.diffWrap}
			label="Wrap long lines"
			hint="Soft-wrap lines that run past the pane instead of scrolling sideways."
		>
			{#snippet control()}
				<Switch checked={getDiffWrap()} onCheckedChange={setDiffWrap} aria-label="Wrap long lines" />
			{/snippet}
		</SettingsRow>
	</SettingsGroup>

	<SettingsGroup heading="Sync">
		<SettingsRow
			row={pane.rows.syncInterval}
			label="Refresh interval"
			hint="How often Revv checks GitHub for new and updated pull requests."
		>
			{#snippet control()}
				<Select.Root type="single" value={String(interval)} onValueChange={handleIntervalChange}>
					<Select.Trigger class="w-48 text-xs" aria-label="Refresh interval">{intervalLabel}</Select.Trigger>
					<Select.Content>
						{#each intervalOptions as option (option.value)}
							<Select.Item value={String(option.value)} class="text-xs">{option.label}</Select.Item>
						{/each}
					</Select.Content>
				</Select.Root>
			{/snippet}
		</SettingsRow>
	</SettingsGroup>

	<SettingsGroup heading="Setup">
		<SettingsRow
			row={pane.rows.replayOnboarding}
			label="Replay onboarding"
			hint="Walk through the setup flow again from the beginning."
		>
			{#snippet control()}
				<Button variant="outline" size="sm" onclick={handleReplayOnboarding} disabled={replaying}>
					{#if replaying}
						<Spinner size={12} class="motion-essential-spin" />
						Starting…
					{:else}
						<ArrowCounterClockwise size={12} />
						Replay
					{/if}
				</Button>
			{/snippet}
		</SettingsRow>
	</SettingsGroup>
</SettingsPane>
