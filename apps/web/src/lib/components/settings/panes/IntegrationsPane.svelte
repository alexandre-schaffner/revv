<script lang="ts">
import {
  EXTERNAL_AGENT_PROVIDER_NAMES,
  EXTERNAL_AGENT_PROVIDERS,
  type ExternalAgentProvider,
} from "@revv/shared";
import Spinner from "phosphor-svelte/lib/Spinner";
import { Button } from "$lib/components/ui/button/index.js";
import {
  fetchExternalIntegrationStatuses,
  getExternalIntegrationAction,
  getExternalIntegrationError,
  getExternalIntegrationStatuses,
  runExternalIntegrationAction,
} from "$lib/stores/external-integrations.svelte";
import SettingsGroup from "../primitives/SettingsGroup.svelte";
import SettingsPane from "../primitives/SettingsPane.svelte";
import SettingsRow from "../primitives/SettingsRow.svelte";
import StatusDot from "../primitives/StatusDot.svelte";
import { SETTINGS_PANES } from "../settings-index";

const statuses = $derived(getExternalIntegrationStatuses());
const action = $derived(getExternalIntegrationAction());
const error = $derived(getExternalIntegrationError());

$effect(() => {
  void fetchExternalIntegrationStatuses();
});

function statusFor(provider: ExternalAgentProvider) {
  return statuses.find((entry) => entry.provider === provider) ?? null;
}

/** What the user still has to do in the agent itself after a connect. */
function activation(provider: ExternalAgentProvider, clientName: string): string {
  switch (provider) {
    case "claude-code":
      return `Run /reload-plugins in an open session, or restart Claude Code. Server: ${clientName}.`;
    case "codex":
      return `Restart Codex, then use /revv-address-feedback-${clientName.slice(5)}.`;
    case "opencode":
      return `Restart opencode, then use /revv-address-feedback-${clientName.slice(5)}.`;
    case "cursor":
      return `Reload the Cursor window, then enable “${clientName}” under Settings → MCP.`;
  }
}

function formatTimestamp(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString();
}

function metaLine(lastUsedAt: string | null, expiresAt: string | null): string | null {
  const parts: string[] = [];
  const used = formatTimestamp(lastUsedAt);
  const expires = formatTimestamp(expiresAt);
  if (used) parts.push(`Last used ${used}`);
  if (expires) parts.push(`Expires ${expires}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}
</script>

<SettingsPane {...SETTINGS_PANES.integrations}>
	<SettingsGroup description="Gives a coding agent the current pull request's walkthrough, issues, and comment threads. It can record verified fixes, update walkthrough content, and reply to or resolve comments. Revv must stay running while the agent is in use.">
		{#each EXTERNAL_AGENT_PROVIDERS as provider (provider)}
			{@const status = statusFor(provider)}
			{@const busy = action?.provider === provider}
			{@const meta = status?.connected ? metaLine(status.lastUsedAt, status.expiresAt) : null}
			<SettingsRow id="integration-{provider}" label={EXTERNAL_AGENT_PROVIDER_NAMES[provider]}>
				{#snippet hint()}
					<span class="integration-status">
						{#if status?.connected}
							<StatusDot tone="success" label="Connected" />
						{:else if status?.clientConfigured}
							<StatusDot tone="warning" label="Inactive: reconnect to repair" />
						{:else}
							<StatusDot tone="muted" label="Not connected" />
						{/if}
						{#if meta}
							<span>{meta}</span>
						{/if}
					</span>
				{/snippet}
				{#snippet control()}
					{#if status?.connected}
						<Button
							variant="outline"
							size="sm"
							onclick={() => runExternalIntegrationAction(provider, 'disconnect')}
							disabled={action !== null}
						>
							{#if busy && action?.kind === 'disconnect'}
								<Spinner size={12} class="motion-essential-spin" />
								Disconnecting…
							{:else}
								Disconnect
							{/if}
						</Button>
					{/if}
					<Button
						variant={status?.connected ? 'secondary' : 'outline'}
						size="sm"
						onclick={() => runExternalIntegrationAction(provider, 'connect')}
						disabled={action !== null}
					>
						{#if busy && action?.kind === 'connect'}
							<Spinner size={12} class="motion-essential-spin" />
							Connecting…
						{:else}
							{status?.connected ? 'Reconnect' : 'Connect'}
						{/if}
					</Button>
				{/snippet}
				{#if status?.connected}
					<p class="integration-activation">{activation(provider, status.clientName)}</p>
				{/if}
			</SettingsRow>
		{/each}
	</SettingsGroup>

	{#if error}
		<p class="integration-error" role="alert">{error}</p>
	{/if}
</SettingsPane>

<style>
	.integration-status {
		display: inline-flex;
		flex-wrap: wrap;
		align-items: center;
		column-gap: 10px;
		row-gap: 2px;
	}

	.integration-activation {
		max-width: 60ch;
		padding: 8px 10px;
		border-radius: 6px;
		background: var(--color-bg-secondary);
		font-size: 12px;
		line-height: 1.45;
		color: var(--color-text-secondary);
		overflow-wrap: anywhere;
	}

	.integration-error {
		font-size: 12px;
		color: var(--color-danger);
	}
</style>
