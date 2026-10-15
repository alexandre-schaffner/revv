<script lang="ts">
import { ACP_AGENTS, type RecapAgentChoice } from "@revv/shared";
import * as Select from "$lib/components/ui/select";
import { Switch } from "$lib/components/ui/switch";
import { getSettings, updateSettings } from "$lib/stores/settings.svelte";
import SettingsGroup from "../primitives/SettingsGroup.svelte";
import SettingsPane from "../primitives/SettingsPane.svelte";
import SettingsRow from "../primitives/SettingsRow.svelte";
import { SETTINGS_PANES } from "../settings-index";

const agentOptions: { value: RecapAgentChoice; label: string }[] = [
  { value: "auto", label: "Follow main agent" },
  ...ACP_AGENTS.map((a) => ({ value: a.id, label: a.label })),
];

const recap = $derived(getSettings()?.recap);
const enabled = $derived(recap?.enabled ?? true);
const agent = $derived(recap?.agent ?? "auto");

function handleAgentChange(value: string | undefined): void {
  const next = agentOptions.find((o) => o.value === value);
  if (next) void updateSettings({ recap: { agent: next.value } });
}
</script>

<SettingsPane {...SETTINGS_PANES.recap}>
	<SettingsGroup>
		<SettingsRow
			id="recap-enabled"
			label="Generate recaps"
			hint="Summarize each repository's merged and in-flight work on a schedule. When off, nothing is generated in the background."
		>
			{#snippet control()}
				<Switch
					checked={enabled}
					onCheckedChange={(v) => void updateSettings({ recap: { enabled: v } })}
					aria-label="Generate recaps"
				/>
			{/snippet}
		</SettingsRow>
	</SettingsGroup>

	<SettingsGroup
		heading="Schedule"
		description="Schedules run on UTC boundaries: daily recaps cover the previous UTC day, weekly ones the previous ISO week."
	>
		<SettingsRow id="recap-daily" label="Daily recap" disabled={!enabled}>
			{#snippet control()}
				<Switch
					checked={recap?.dailyEnabled ?? true}
					disabled={!enabled}
					onCheckedChange={(v) => void updateSettings({ recap: { dailyEnabled: v } })}
					aria-label="Daily recap"
				/>
			{/snippet}
		</SettingsRow>
		<SettingsRow id="recap-weekly" label="Weekly recap" disabled={!enabled}>
			{#snippet control()}
				<Switch
					checked={recap?.weeklyEnabled ?? true}
					disabled={!enabled}
					onCheckedChange={(v) => void updateSettings({ recap: { weeklyEnabled: v } })}
					aria-label="Weekly recap"
				/>
			{/snippet}
		</SettingsRow>
		<SettingsRow
			id="recap-agent"
			label="Recap agent"
			hint="Which agent writes recaps. Following the main agent keeps it in step with Settings → AI agent."
			disabled={!enabled}
		>
			{#snippet control()}
				<Select.Root type="single" value={agent} onValueChange={handleAgentChange} disabled={!enabled}>
					<Select.Trigger class="w-48 text-xs" aria-label="Recap agent">
						<span class="truncate">{agentOptions.find((o) => o.value === agent)?.label ?? 'Follow main agent'}</span>
					</Select.Trigger>
					<Select.Content>
						{#each agentOptions as opt (opt.value)}
							<Select.Item value={opt.value} class="text-xs">{opt.label}</Select.Item>
						{/each}
					</Select.Content>
				</Select.Root>
			{/snippet}
		</SettingsRow>
	</SettingsGroup>
</SettingsPane>
