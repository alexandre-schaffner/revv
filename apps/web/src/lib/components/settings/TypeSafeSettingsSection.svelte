<script lang="ts">
import { JEV_HOOK_DEFAULTS, JEV_HOOK_KEYS, JEV_HOOKS, type JevHookKey } from "@revv/shared";
import Spinner from "phosphor-svelte/lib/Spinner";
import { API_BASE_URL } from "$lib/api/base-url";
import { Button } from "$lib/components/ui/button/index.js";
import { Input } from "$lib/components/ui/input";
import { Switch } from "$lib/components/ui/switch";
import { fetchSettings, getSettings, updateSettings } from "$lib/stores/settings.svelte";
import { resetWalkthroughSizings } from "$lib/stores/walkthrough-sizing.svelte";
import { authHeaders } from "$lib/utils/session-token";

let apiKeyDraft = $state("");
let apiKeySaving = $state(false);

type TestResult = { ok: true; model: string; latencyMs: number } | { ok: false; error: string };
let testState = $state<TestResult | null>(null);
let testRunning = $state(false);

async function saveApiKey(value: string): Promise<void> {
  if (apiKeySaving) return;
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

function hookDisabled(key: JevHookKey): boolean {
  const jev = getSettings()?.jev;
  if (!jev?.enabled) return true;
  return key === "hideLowSignal" && !jev.issueScoring;
}

function setHook(key: JevHookKey, value: boolean): void {
  void updateSettings({ jev: { [key]: value } });
}
</script>

<section id="section-jev" class="settings-section">
  <h2 class="section-head-title">TypeSafe</h2>

  <p class="section-blurb">
    TypeSafe's System One model answers closed-set questions without generating text. Revv uses it
    where a full coding agent is overkill. Every feature degrades to the agent's own judgment when
    TypeSafe is off or unreachable.
  </p>

  <div class="settings-subgroup">
    <div class="settings-row">
      <div class="settings-row-info">
        <p class="settings-row-label">Enable TypeSafe</p>
        <p class="settings-row-hint">
          Off by default. When disabled, no hooks run and no requests are made.
        </p>
      </div>
      <Switch
        checked={getSettings()?.jev.enabled ?? false}
        onCheckedChange={(value) => {
          void updateSettings({ jev: { enabled: value } });
        }}
        aria-label="Enable TypeSafe"
      />
    </div>
  </div>

  <div class="settings-subgroup">
    <h3 class="settings-subgroup-heading">Connection</h3>

    <div class="settings-field">
      <label class="settings-field-label" for="jev-api-key">API key</label>
      <Input
        id="jev-api-key"
        type="password"
        autocomplete="off"
        placeholder={getSettings()?.jev.hasApiKey
          ? "A key is saved — paste a new one to replace it"
          : "apikey_…"}
        bind:value={apiKeyDraft}
        disabled={apiKeySaving}
        onchange={() => {
          void saveApiKey(apiKeyDraft);
        }}
      />
      <p class="settings-field-hint">
        Stored in your OS keychain, never in the settings database. Saved when you press Enter or
        leave the field.
      </p>
    </div>

    <div class="flex items-center gap-3 pt-1">
      <Button
        variant="outline"
        size="sm"
        onclick={testConnection}
        disabled={testRunning || !(getSettings()?.jev.hasApiKey ?? false)}
      >
        {#if testRunning}
          <Spinner size={14} class="motion-essential-spin" />
        {/if}
        Test connection
      </Button>
      {#if getSettings()?.jev.hasApiKey}
        <Button variant="ghost" size="sm" onclick={clearApiKey} disabled={apiKeySaving}>
          Remove key
        </Button>
      {/if}
      {#if testState}
        <span
          class="probe-result"
          class:probe-result--ok={testState.ok}
          class:probe-result--err={!testState.ok}
        >
          {#if testState.ok}
            {testState.model} responded in {testState.latencyMs}ms
          {:else}
            {testState.error}
          {/if}
        </span>
      {/if}
    </div>
  </div>

  <div class="settings-subgroup">
    <h3 class="settings-subgroup-heading">Features</h3>

    {#each JEV_HOOK_KEYS as hookKey (hookKey)}
      {@const definition = JEV_HOOKS[hookKey]}
      <div class="settings-row">
        <div class="settings-row-info">
          <p class="settings-row-label">{definition.label}</p>
          <p class="settings-row-hint">{definition.hint}</p>
        </div>
        <Switch
          checked={getSettings()?.jev[hookKey] ?? JEV_HOOK_DEFAULTS[hookKey]}
          disabled={hookDisabled(hookKey)}
          onCheckedChange={(value) => setHook(hookKey, value)}
          aria-label={definition.ariaLabel}
        />
      </div>
    {/each}
  </div>
</section>
