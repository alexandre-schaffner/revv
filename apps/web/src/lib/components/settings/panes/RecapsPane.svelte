<script module lang="ts">
import CalendarDots from "phosphor-svelte/lib/CalendarDots";
import { defineSettingsPane } from "../settings-panes";

export const pane = defineSettingsPane({
  id: "recap",
  title: "Recaps",
  description: "Daily and weekly summaries of what shipped in each repository.",
  icon: CalendarDots,
  rows: {
    enabled: { label: "Generate recaps", keywords: ["summary", "digest", "project recap"] },
    daily: { label: "Daily recap", keywords: ["every day", "schedule"] },
    weekly: { label: "Weekly recap", keywords: ["every week", "schedule"] },
    agent: { label: "Recap agent", keywords: ["provider", "model"] },
  },
});
</script>

<script lang="ts">
import { ACP_AGENTS, type RecapAgentChoice } from "@revv/shared";
import * as Select from "$lib/components/ui/select";
import { Switch } from "$lib/components/ui/switch";
import { getSettings, updateSettings } from "$lib/stores/settings.svelte";
import SettingsGroup from "../primitives/SettingsGroup.svelte";
import SettingsPane from "../primitives/SettingsPane.svelte";
import SettingsRow from "../primitives/SettingsRow.svelte";

const agentOptions: { value: RecapAgentChoice; label: string }[] = [
  { value: "auto", label: "Follow main agent" },
  ...ACP_AGENTS.map((a) => ({ value: a.id, label: a.label })),
];

const recap = $derived(getSettings().recap);
const enabled = $derived(recap.enabled);
const agent = $derived(recap.agent);

function handleAgentChange(value: string | undefined): void {
  const next = agentOptions.find((o) => o.value === value);
  if (next) void updateSettings({ recap: { agent: next.value } });
}
</script>

<SettingsPane {pane}>
	<SettingsGroup>
		<SettingsRow
			row={pane.rows.enabled}
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
		<SettingsRow row={pane.rows.daily} label="Daily recap" disabled={!enabled}>
			{#snippet control()}
				<Switch
					checked={recap.dailyEnabled}
					disabled={!enabled}
					onCheckedChange={(v) => void updateSettings({ recap: { dailyEnabled: v } })}
					aria-label="Daily recap"
				/>
			{/snippet}
		</SettingsRow>
		<SettingsRow row={pane.rows.weekly} label="Weekly recap" disabled={!enabled}>
			{#snippet control()}
				<Switch
					checked={recap.weeklyEnabled}
					disabled={!enabled}
					onCheckedChange={(v) => void updateSettings({ recap: { weeklyEnabled: v } })}
					aria-label="Weekly recap"
				/>
			{/snippet}
		</SettingsRow>
		<SettingsRow
			row={pane.rows.agent}
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
