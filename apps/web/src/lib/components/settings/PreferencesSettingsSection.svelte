<script lang="ts">
import Desktop from "phosphor-svelte/lib/Desktop";
import Moon from "phosphor-svelte/lib/Moon";
import Sun from "phosphor-svelte/lib/Sun";
import * as Select from "$lib/components/ui/select";
import { getSettings, updateSettings } from "$lib/stores/settings.svelte";
import {
  getThemePreference,
  setThemePreference,
  type ThemePreference,
} from "$lib/stores/theme.svelte";

const intervalOptions = [
  { label: "Disabled", value: 0 },
  { label: "1 minute", value: 1 },
  { label: "5 minutes", value: 5 },
  { label: "10 minutes", value: 10 },
  { label: "15 minutes", value: 15 },
  { label: "30 minutes", value: 30 },
];

const themeOptions: { value: ThemePreference; label: string; icon: typeof Sun }[] = [
  { value: "system", label: "System", icon: Desktop },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
];
</script>

<section id="section-preferences" class="settings-section">
  <h2 class="section-head-title">Preferences</h2>

  <div class="settings-subgroup">
    <h3 class="settings-subgroup-heading">Appearance</h3>
    <div class="settings-row">
      <div class="settings-row-info">
        <p class="settings-row-label">Theme</p>
        <p class="settings-row-hint">Light, dark, or follow system preference.</p>
      </div>
      <div class="flex w-fit items-center gap-1 rounded-md border border-border-subtle bg-bg-elevated p-0.5">
        {#each themeOptions as option (option.value)}
          <button
            type="button"
            class="flex items-center gap-1.5 rounded px-2.5 py-1 text-xs transition-colors"
            class:bg-bg-primary={getThemePreference() === option.value}
            class:text-text-primary={getThemePreference() === option.value}
            class:text-text-muted={getThemePreference() !== option.value}
            onclick={() => setThemePreference(option.value)}
          >
            <option.icon size={11} />
            {option.label}
          </button>
        {/each}
      </div>
    </div>
  </div>

  <div class="settings-subgroup">
    <h3 class="settings-subgroup-heading">Sync</h3>
    <div class="settings-row">
      <div class="settings-row-info">
        <p class="settings-row-label">Sync interval</p>
        <p class="settings-row-hint">How often Revv polls GitHub for new PRs.</p>
      </div>
      <Select.Root
        type="single"
        value={String(getSettings()?.autoFetchInterval ?? 5)}
        onValueChange={(value) => {
          if (value) void updateSettings({ autoFetchInterval: Number(value) });
        }}
      >
        <Select.Trigger class="w-40 text-xs">
          {intervalOptions.find(
            (option) => option.value === (getSettings()?.autoFetchInterval ?? 5),
          )?.label ?? "5 minutes"}
        </Select.Trigger>
        <Select.Content>
          {#each intervalOptions as option (option.value)}
            <Select.Item value={String(option.value)} class="text-xs">{option.label}</Select.Item>
          {/each}
        </Select.Content>
      </Select.Root>
    </div>
  </div>
</section>
