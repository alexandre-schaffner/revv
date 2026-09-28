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
import { restartPolling } from "$lib/services/sync";
import { resetOnboarding } from "$lib/stores/auth.svelte";
import { getDiffWrap, setDiffWrap } from "$lib/stores/diff-prefs.svelte";
import { getDiffMode, setDiffMode } from "$lib/stores/review.svelte";
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
import { SETTINGS_PANES } from "../settings-index";

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

const interval = $derived(getSettings()?.autoFetchInterval ?? 5);
const intervalLabel = $derived(
  intervalOptions.find((o) => o.value === interval)?.label ?? `Every ${interval} minutes`,
);

function handleIntervalChange(value: string | undefined): void {
  if (!value) return;
  const minutes = Number(value);
  void updateSettings({ autoFetchInterval: minutes });
  restartPolling(minutes);
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

<SettingsPane {...SETTINGS_PANES.general}>
	<SettingsGroup heading="Appearance">
		<SettingsRow id="theme" label="Theme" hint="Follow the system, or pin light or dark.">
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
			id="diff-theme"
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
			id="diff-layout"
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
			id="diff-wrap"
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
			id="sync-interval"
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
			id="replay-onboarding"
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
