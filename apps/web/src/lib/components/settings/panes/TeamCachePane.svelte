<script lang="ts">
import Spinner from "phosphor-svelte/lib/Spinner";
import { API_BASE_URL } from "$lib/api/base-url";
import { Button } from "$lib/components/ui/button/index.js";
import { SegmentedControl, type SegmentedOption } from "$lib/components/ui/segmented-control";
import { Switch } from "$lib/components/ui/switch";
import { getSettings, updateSettings } from "$lib/stores/settings.svelte";
import { authHeaders } from "$lib/utils/session-token";
import CommitInput from "../primitives/CommitInput.svelte";
import SettingsGroup from "../primitives/SettingsGroup.svelte";
import SettingsPane from "../primitives/SettingsPane.svelte";
import SettingsRow from "../primitives/SettingsRow.svelte";
import StatusDot from "../primitives/StatusDot.svelte";
import { SETTINGS_PANES } from "../settings-index";

const cache = $derived(getSettings()?.cache);
const enabled = $derived(cache?.enabled ?? false);

// ── Connection test ───────────────────────────────────────────────────────
let cacheTestState = $state<{ healthy: boolean; detail: string } | null>(null);
let cacheTestRunning = $state(false);

async function testCacheConnection(): Promise<void> {
  if (cacheTestRunning) return;
  cacheTestRunning = true;
  try {
    const res = await fetch(`${API_BASE_URL}/api/settings/cache/status`, {
      headers: await authHeaders(),
    });
    if (!res.ok) {
      cacheTestState = { healthy: false, detail: `HTTP ${res.status}` };
      return;
    }
    cacheTestState = (await res.json()) as { healthy: boolean; detail: string };
  } catch (e) {
    cacheTestState = { healthy: false, detail: e instanceof Error ? e.message : String(e) };
  } finally {
    cacheTestRunning = false;
  }
}

// ── ADC (Application Default Credentials) status ──────────────────────────
type AdcStatus =
  | { available: true; source: string; gcloudFound: boolean; gcloudPath: string | null }
  | {
      available: false;
      source: null;
      gcloudFound: boolean;
      gcloudPath: string | null;
      adcPath: string | null;
    };

type AdcState = { kind: "loading" } | { kind: "error" } | { kind: "ready"; status: AdcStatus };
let adc = $state<AdcState>({ kind: "loading" });
let adcPolling = $state(false);

async function fetchAdcStatus(): Promise<void> {
  try {
    const res = await fetch(`${API_BASE_URL}/api/settings/cache/adc-status`, {
      headers: await authHeaders(),
    });
    adc = res.ok ? { kind: "ready", status: (await res.json()) as AdcStatus } : { kind: "error" };
  } catch {
    adc = { kind: "error" };
  }
}

// Only probe credentials while the cache is on. It used to be fetched on open
// regardless, and with the cache off the "Checking…" spinner never resolved.
$effect(() => {
  if (enabled) void fetchAdcStatus();
});

let adcPollTimers: {
  interval: ReturnType<typeof setInterval>;
  timeout: ReturnType<typeof setTimeout>;
} | null = null;

function stopAdcPolling(): void {
  if (adcPollTimers) {
    clearInterval(adcPollTimers.interval);
    clearTimeout(adcPollTimers.timeout);
    adcPollTimers = null;
  }
  adcPolling = false;
}

$effect(() => stopAdcPolling);

async function startAdcLogin(): Promise<void> {
  try {
    const res = await fetch(`${API_BASE_URL}/api/settings/cache/adc-login`, {
      method: "POST",
      headers: await authHeaders(),
    });
    if (!res.ok) return;
    const data = (await res.json()) as { started: boolean; error?: string };
    if (!data.started) return;
    // Poll until ADC becomes available, for at most a minute.
    stopAdcPolling();
    adcPolling = true;
    adcPollTimers = {
      interval: setInterval(async () => {
        await fetchAdcStatus();
        if (adc.kind === "ready" && adc.status.available) stopAdcPolling();
      }, 2000),
      timeout: setTimeout(stopAdcPolling, 60000),
    };
  } catch {
    // ignore
  }
}

// ── Signing ───────────────────────────────────────────────────────────────
type SigningMode = "off" | "permissive" | "strict";

const signingModeOptions: SegmentedOption<SigningMode>[] = [
  { value: "strict", label: "Strict" },
  { value: "permissive", label: "Permissive" },
  { value: "off", label: "Off" },
];

const signingModeDescriptions: Record<SigningMode, string> = {
  strict: "Sign on upload, and reject any snapshot whose signature is missing or invalid.",
  permissive: "Sign on upload, and accept unsigned or invalid snapshots with a warning.",
  off: "No signing on upload and no verification on download.",
};

const signingMode = $derived<SigningMode>(cache?.signing?.mode ?? "strict");

// Round-trips a probe message through the local SSH key + the user's published
// `.keys`. Surfaces the specific signer service error verbatim so a user can
// see e.g. "no key in ~/.ssh matches your GitHub keys" or ssh-keygen output.
type SigningTestResult =
  | { ok: true; signerLogin: string; signerHost: string; signatureNamespace: string }
  | { ok: false; error: string };
let signingTestState = $state<SigningTestResult | null>(null);
let signingTestRunning = $state(false);

async function testCacheSigning(): Promise<void> {
  if (signingTestRunning) return;
  signingTestRunning = true;
  try {
    const res = await fetch(`${API_BASE_URL}/api/settings/cache/signing/test`, {
      method: "POST",
      headers: await authHeaders(),
    });
    if (!res.ok) {
      signingTestState = { ok: false, error: `HTTP ${res.status}` };
      return;
    }
    signingTestState = (await res.json()) as SigningTestResult;
  } catch (e) {
    signingTestState = { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    signingTestRunning = false;
  }
}

function parseTrustedHosts(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((h) => h.trim())
    .filter(Boolean);
}
</script>

<SettingsPane {...SETTINGS_PANES.cache}>
	<SettingsGroup>
		<SettingsRow
			id="cache-enabled"
			label="Enable team cache"
			hint="Teammates who open a pull request you've already reviewed load your walkthrough instead of re-running the agent. Uses a Google Cloud Storage bucket; its IAM grants are the team boundary."
		>
			{#snippet control()}
				<Switch
					checked={enabled}
					onCheckedChange={(v) => void updateSettings({ cache: { enabled: v } })}
					aria-label="Enable team cache"
				/>
			{/snippet}
		</SettingsRow>
	</SettingsGroup>

	{#if !enabled}
		<p class="cache-off">
			Off. Turning it on reveals the bucket, sharing, and signing settings. Nothing is probed,
			uploaded, or downloaded until then.
		</p>
	{:else}
		<SettingsGroup heading="Connection">
			<SettingsRow id="cache-bucket" label="Bucket name" labelFor="cache-bucket-input" layout="stacked">
				{#snippet control()}
					<CommitInput
						id="cache-bucket-input"
						mono
						placeholder="my-team-revv-cache"
						value={cache?.bucket ?? ''}
						onCommit={(bucket) => updateSettings({ cache: { bucket } })}
					/>
				{/snippet}
			</SettingsRow>

			<SettingsRow id="cache-credentials" label="Google Cloud credentials">
				{#snippet hint()}
					{#if adc.kind === 'ready' && !adc.status.available && !adc.status.gcloudFound}
						Install the <a href="https://cloud.google.com/sdk/docs/install" target="_blank" rel="noopener noreferrer">Google Cloud SDK</a>,
						then run <code>gcloud auth application-default login</code>.
					{:else}
						Revv reads the bucket with your Application Default Credentials.
					{/if}
				{/snippet}
				{#snippet control()}
					{#if adc.kind === 'loading'}
						<span class="checking">
							<Spinner size={12} class="motion-essential-spin" />
							Checking…
						</span>
					{:else if adc.kind === 'error'}
						<StatusDot tone="muted" label="Couldn't check" />
						<Button variant="ghost" size="sm" onclick={fetchAdcStatus}>Retry</Button>
					{:else if adc.status.available}
						<StatusDot tone="success" label="Ready" />
					{:else if adc.status.gcloudFound}
						<StatusDot tone="warning" label="Not signed in" />
						<Button variant="outline" size="sm" onclick={startAdcLogin} disabled={adcPolling}>
							{#if adcPolling}
								<Spinner size={12} class="motion-essential-spin" />
								Waiting for sign-in…
							{:else}
								Sign in
							{/if}
						</Button>
					{:else}
						<StatusDot tone="warning" label="SDK not found" />
					{/if}
				{/snippet}
			</SettingsRow>

			<SettingsRow id="cache-test" label="Test connection" hint="Probes the bucket with your current credentials.">
				{#snippet control()}
					<Button variant="outline" size="sm" onclick={testCacheConnection} disabled={cacheTestRunning}>
						{#if cacheTestRunning}
							<Spinner size={12} class="motion-essential-spin" />
						{/if}
						Test connection
					</Button>
				{/snippet}
				{#if cacheTestState}
					{#if cacheTestState.healthy}
						<StatusDot tone="success" label={cacheTestState.detail} />
					{:else}
						<p class="probe-error" role="alert">{cacheTestState.detail}</p>
					{/if}
				{/if}
			</SettingsRow>
		</SettingsGroup>

		<SettingsGroup heading="Sharing">
			<SettingsRow
				id="cache-uploads"
				label="Upload finished walkthroughs"
				hint="Push your generations to the bucket so teammates can load them."
			>
				{#snippet control()}
					<Switch
						checked={cache?.uploadsEnabled ?? true}
						onCheckedChange={(v) => void updateSettings({ cache: { uploadsEnabled: v } })}
						aria-label="Upload finished walkthroughs"
					/>
				{/snippet}
			</SettingsRow>
			<SettingsRow
				id="cache-downloads"
				label="Hydrate from team cache"
				hint="On a cache hit, skip the agent and load the teammate's snapshot."
			>
				{#snippet control()}
					<Switch
						checked={cache?.downloadsEnabled ?? true}
						onCheckedChange={(v) => void updateSettings({ cache: { downloadsEnabled: v } })}
						aria-label="Hydrate from team cache"
					/>
				{/snippet}
			</SettingsRow>
		</SettingsGroup>

		<SettingsGroup heading="Signing">
			<SettingsRow id="cache-signing-mode" label="Verification mode" hint={signingModeDescriptions[signingMode]}>
				{#snippet control()}
					<SegmentedControl
						aria-label="Verification mode"
						options={signingModeOptions}
						value={signingMode}
						onValueChange={(mode) => void updateSettings({ cache: { signing: { mode } } })}
					/>
				{/snippet}
			</SettingsRow>

			<SettingsRow
				id="cache-key-path"
				label="SSH private key path"
				labelFor="cache-key-path-input"
				layout="stacked"
			>
				{#snippet hint()}
					Leave empty to use the first key in <code>~/.ssh</code> whose public half is on your GitHub
					<code>.keys</code> page. Revv never reads the private key; <code>ssh-keygen</code> signs.
				{/snippet}
				{#snippet control()}
					<CommitInput
						id="cache-key-path-input"
						mono
						placeholder="Auto-detect from ~/.ssh"
						value={cache?.signing?.keyPath ?? ''}
						onCommit={(keyPath) => updateSettings({ cache: { signing: { keyPath } } })}
					/>
				{/snippet}
			</SettingsRow>

			<SettingsRow
				id="cache-trusted-hosts"
				label="Trusted signer hosts"
				labelFor="cache-trusted-hosts-input"
				layout="stacked"
				hint="Comma-separated. Snapshots signed from any other host are rejected before a network call."
			>
				{#snippet control()}
					<CommitInput
						id="cache-trusted-hosts-input"
						mono
						placeholder="github.com, acme.ghe.com"
						value={(cache?.signing?.trustedSignerHosts ?? []).join(', ')}
						onCommit={(text) =>
							updateSettings({ cache: { signing: { trustedSignerHosts: parseTrustedHosts(text) } } })}
					/>
				{/snippet}
			</SettingsRow>

			<SettingsRow id="cache-test-signing" label="Test signing">
				{#snippet hint()}
					Signs a probe with your key and verifies it against <code>https://&lt;host&gt;/&lt;login&gt;.keys</code>.
				{/snippet}
				{#snippet control()}
					<Button variant="outline" size="sm" onclick={testCacheSigning} disabled={signingTestRunning}>
						{#if signingTestRunning}
							<Spinner size={12} class="motion-essential-spin" />
						{/if}
						Test signing
					</Button>
				{/snippet}
				{#if signingTestState}
					{#if signingTestState.ok}
						<StatusDot
							tone="success"
							label="Signed and verified as {signingTestState.signerLogin}@{signingTestState.signerHost}"
						/>
					{:else}
						<p class="probe-error" role="alert">{signingTestState.error}</p>
					{/if}
				{/if}
			</SettingsRow>
		</SettingsGroup>
	{/if}
</SettingsPane>

<style>
	.cache-off {
		max-width: 60ch;
		padding: 0 4px;
		font-size: 12px;
		line-height: 1.5;
		color: var(--color-text-secondary);
	}

	.checking {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 12px;
		color: var(--color-text-secondary);
	}

	.probe-error {
		font-size: 12px;
		line-height: 1.45;
		color: var(--color-danger);
		overflow-wrap: anywhere;
		white-space: pre-wrap;
	}
</style>
