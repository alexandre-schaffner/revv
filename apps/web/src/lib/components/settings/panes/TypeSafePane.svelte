<script lang="ts">
import Spinner from "phosphor-svelte/lib/Spinner";
import { API_BASE_URL } from "$lib/api/base-url";
import { Button } from "$lib/components/ui/button/index.js";
import { Input } from "$lib/components/ui/input";
import { Switch } from "$lib/components/ui/switch";
import { fetchSettings, getSettings, updateSettings } from "$lib/stores/settings.svelte";
import { resetWalkthroughSizings } from "$lib/stores/walkthrough-sizing.svelte";
import { authHeaders } from "$lib/utils/session-token";
import SettingsGroup from "../primitives/SettingsGroup.svelte";
import SettingsPane from "../primitives/SettingsPane.svelte";
import SettingsRow from "../primitives/SettingsRow.svelte";
import StatusDot from "../primitives/StatusDot.svelte";
import { SETTINGS_PANES } from "../settings-index";

const hasApiKey = $derived(getSettings()?.jev.hasApiKey ?? false);

let apiKeyDraft = $state("");
let apiKeySaving = $state(false);

type TestResult = { ok: true; model: string; latencyMs: number } | { ok: false; error: string };
let testState = $state<TestResult | null>(null);
let testRunning = $state(false);

async function saveApiKey(value: string): Promise<void> {
  if (apiKeySaving || !value) return;
  apiKeySaving = true;
  testState = null;
  try {
    const res = await fetch(`${API_BASE_URL}/api/settings/jev/api-key`, {
      method: "PUT",
      headers: { ...(await authHeaders()), "content-type": "application/json" },
      body: JSON.stringify({ apiKey: value }),
    });
    if (res.ok) {
      apiKeyDraft = "";
      resetWalkthroughSizings();
      await fetchSettings();
    } else {
      testState = { ok: false, error: `Could not save the key (HTTP ${res.status}).` };
    }
  } catch (error) {
    testState = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    apiKeySaving = false;
  }
}

async function clearApiKey(): Promise<void> {
  if (apiKeySaving) return;
  apiKeySaving = true;
  testState = null;
  try {
    await fetch(`${API_BASE_URL}/api/settings/jev/api-key`, {
      method: "DELETE",
      headers: await authHeaders(),
    });
    apiKeyDraft = "";
    resetWalkthroughSizings();
    await fetchSettings();
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
    const res = await fetch(`${API_BASE_URL}/api/settings/jev/test`, {
      method: "POST",
      headers: await authHeaders(),
    });
    if (!res.ok) {
      testState = { ok: false, error: `HTTP ${res.status}` };
      return;
    }
    testState = (await res.json()) as TestResult;
  } catch (error) {
    testState = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    testRunning = false;
  }
}
</script>

<SettingsPane {...SETTINGS_PANES.jev}>
	<SettingsGroup description="TypeSafe's System One model answers closed-set questions without generating text. Everything falls back to the agent's own judgment when TypeSafe is off or unreachable.">
		<SettingsRow
			id="jev-enabled"
			label="Use TypeSafe judgments"
			hint="Sizes each review, sets its risk tier, ranks the changed files, checks and calibrates flagged issues, holds artifacts and prose to the bar, and stops doomed retries. When off, no requests are made."
		>
			{#snippet control()}
				<Switch
					checked={getSettings()?.jev.enabled ?? false}
					onCheckedChange={(value) => void updateSettings({ jev: { enabled: value } })}
					aria-label="Use TypeSafe judgments"
				/>
			{/snippet}
		</SettingsRow>
	</SettingsGroup>

	<SettingsGroup heading="Connection">
		<SettingsRow
			id="jev-api-key"
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
			id="jev-test"
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
