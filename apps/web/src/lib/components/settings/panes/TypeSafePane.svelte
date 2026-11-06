<script module lang="ts">
import Gauge from "phosphor-svelte/lib/Gauge";
import { defineSettingsPane } from "../settings-panes";

export const pane = defineSettingsPane({
  id: "jev",
  title: "TypeSafe",
  description: "Calibrated yes-or-no judgments where a full agent turn is overkill.",
  icon: Gauge,
  rows: {
    enabled: { label: "Use TypeSafe judgments", keywords: ["jev", "system one", "sizing", "risk"] },
    apiKey: { label: "TypeSafe API key", keywords: ["jev", "key", "token"] },
    test: { label: "Test TypeSafe connection", keywords: ["jev", "latency"] },
  },
});
</script>

<script lang="ts">
import Spinner from "phosphor-svelte/lib/Spinner";
import { api } from "$lib/api/client";
import { apiErrorMessage } from "$lib/api/errors";
import { type EdenData, thrownMessage } from "$lib/api/wire";
import { Button } from "$lib/components/ui/button/index.js";
import { Input } from "$lib/components/ui/input";
import { Switch } from "$lib/components/ui/switch";
import { fetchSettings, getSettings, updateSettings } from "$lib/stores/settings.svelte";
import { reset as resetWalkthroughSizings } from "$lib/stores/walkthrough-sizing.svelte";
import SettingsGroup from "../primitives/SettingsGroup.svelte";
import SettingsPane from "../primitives/SettingsPane.svelte";
import SettingsRow from "../primitives/SettingsRow.svelte";
import StatusDot from "../primitives/StatusDot.svelte";

const hasApiKey = $derived(getSettings().jev.hasApiKey);

let apiKeyDraft = $state("");
let apiKeySaving = $state(false);

type TestResult = EdenData<typeof api.api.settings.jev.test.post>;
let testState = $state<TestResult | null>(null);
let testRunning = $state(false);

/** A key change re-gates every sizing; `hasApiKey` is re-read from the server. */
async function afterKeyChange(): Promise<void> {
  apiKeyDraft = "";
  resetWalkthroughSizings();
  await fetchSettings();
}

async function saveApiKey(value: string): Promise<void> {
  if (apiKeySaving || !value) return;
  apiKeySaving = true;
  testState = null;
  try {
    const { error } = await api.api.settings.jev["api-key"].put({ apiKey: value });
    if (error) testState = { ok: false, error: apiErrorMessage(error, "Could not save the key") };
    else await afterKeyChange();
  } catch (e) {
    testState = { ok: false, error: thrownMessage(e) };
  } finally {
    apiKeySaving = false;
  }
}

async function clearApiKey(): Promise<void> {
  if (apiKeySaving) return;
  apiKeySaving = true;
  testState = null;
  try {
    await api.api.settings.jev["api-key"].delete();
    await afterKeyChange();
  } catch {
    // Best-effort: the next settings fetch reconciles the real state.
  } finally {
    apiKeySaving = false;
  }
}

async function testConnection(): Promise<void> {
  if (testRunning) return;
  testRunning = true;
  try {
    const { data, error } = await api.api.settings.jev.test.post();
    testState = error ? { ok: false, error: apiErrorMessage(error, "Test failed") } : data;
  } catch (e) {
    testState = { ok: false, error: thrownMessage(e) };
  } finally {
    testRunning = false;
  }
}
</script>

<SettingsPane {pane}>
	<SettingsGroup description="TypeSafe's System One model answers closed-set questions without generating text. Everything falls back to the agent's own judgment when TypeSafe is off or unreachable.">
		<SettingsRow
			row={pane.rows.enabled}
			label="Use TypeSafe judgments"
			hint="Sizes each review, sets its risk tier, ranks the changed files, runs a hunk-by-hunk first pass, checks and calibrates flagged issues, holds artifacts and prose to the bar, and stops doomed retries. When off, no requests are made."
		>
			{#snippet control()}
				<Switch
					checked={getSettings().jev.enabled}
					onCheckedChange={(value) => void updateSettings({ jev: { enabled: value } })}
					aria-label="Use TypeSafe judgments"
				/>
			{/snippet}
		</SettingsRow>
	</SettingsGroup>

	<SettingsGroup heading="Connection">
		<SettingsRow
			row={pane.rows.apiKey}
			label="API key"
			labelFor="jev-api-key-input"
			layout="stacked"
			hint="Stored in your OS keychain, never in the settings database. Saved when you press Enter or leave the field."
		>
			{#snippet control()}
				<Input
					id="jev-api-key-input"
					type="password"
					autocomplete="off"
					placeholder={hasApiKey ? "A key is saved. Paste a new one to replace it" : "apikey_…"}
					bind:value={apiKeyDraft}
					disabled={apiKeySaving}
					onchange={() => void saveApiKey(apiKeyDraft)}
				/>
			{/snippet}
		</SettingsRow>
		<SettingsRow
			row={pane.rows.test}
			label="Test connection"
			hint="Sends one judgment to TypeSafe and reports how long it took."
		>
			{#snippet control()}
				{#if hasApiKey}
					<Button variant="ghost" size="sm" onclick={clearApiKey} disabled={apiKeySaving}>Remove key</Button>
				{/if}
				<Button variant="outline" size="sm" onclick={testConnection} disabled={testRunning || !hasApiKey}>
					{#if testRunning}
						<Spinner size={12} class="motion-essential-spin" />
					{/if}
					Test connection
				</Button>
			{/snippet}
			{#if testState}
				{#if testState.ok}
					<StatusDot tone="success" label="{testState.model} responded in {testState.latencyMs}ms" />
				{:else}
					<p class="test-error" role="alert">{testState.error}</p>
				{/if}
			{/if}
		</SettingsRow>
	</SettingsGroup>
</SettingsPane>

<style>
	.test-error {
		font-size: 12px;
		line-height: 1.45;
		color: var(--color-danger);
		overflow-wrap: anywhere;
	}
</style>
