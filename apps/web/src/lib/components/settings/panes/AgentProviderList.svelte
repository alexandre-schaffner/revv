<script lang="ts">
import { ACP_AGENTS, type AcpAgentId, type AgentStatusReport } from "@revv/shared";
import { RadioGroup } from "bits-ui";
import Spinner from "phosphor-svelte/lib/Spinner";
import Warning from "phosphor-svelte/lib/Warning";
import { agentReadiness } from "$lib/agent-setup/readiness";
import {
  endAgentSignIn,
  getAgentInstall,
  getSigningInAgent,
  startAgentInstall,
  startAgentSignIn,
} from "$lib/agent-setup/store.svelte";
import { acpAgentIcon } from "$lib/components/icons/acpAgentIcon";
import AgentLoginTerminal from "$lib/components/agent-setup/AgentLoginTerminal.svelte";
import { Button } from "$lib/components/ui/button/index.js";
import { fetchAgentStatus } from "$lib/stores/settings.svelte";
import StatusDot from "../primitives/StatusDot.svelte";
import type { SettingsRowRef } from "../settings-panes";

// One radio row per registry agent, each carrying its own live status. The
// selected row expands in place to whatever it still needs: install, sign-in,
// a terminal command, or a reconnect.

interface Props {
  /** The search anchor for the whole list. */
  row: SettingsRowRef;
  selected: AcpAgentId;
  status: AgentStatusReport | null;
  loading: boolean;
  onSelect: (agent: AcpAgentId) => void;
}

let { row, selected, status, loading, onSelect }: Props = $props();

const install = $derived(getAgentInstall());
const signingInAgent = $derived(getSigningInAgent());

function handleChange(value: string): void {
  const agent = ACP_AGENTS.find((a) => a.id === value);
  if (agent && agent.id !== selected) onSelect(agent.id);
}

async function onLoginDone(): Promise<void> {
  await fetchAgentStatus();
  endAgentSignIn();
}
</script>

<RadioGroup.Root
	value={selected}
	onValueChange={handleChange}
	loop
	aria-label="Agent"
	class="provider-list"
	data-setting-id={row.anchor}
>
	{#each ACP_AGENTS as agent (agent.id)}
		{@const s = status?.agents[agent.id] ?? null}
		{@const readiness = agentReadiness(s)}
		{@const Icon = acpAgentIcon(agent.icon)}
		{@const isSelected = agent.id === selected}
		<div class="provider">
			<RadioGroup.Item value={agent.id} class="provider-item">
				{#snippet children({ checked })}
					<span class="provider-radio" class:provider-radio--checked={checked} aria-hidden="true"></span>
					<Icon size={16} class="provider-icon" />
					<span class="provider-text">
						<span class="provider-name">{agent.label}</span>
						<span class="provider-description">{agent.description}</span>
					</span>
					<StatusDot tone={readiness.tone} label={!s && loading ? "Checking…" : readiness.label} />
				{/snippet}
			</RadioGroup.Item>

			{#if isSelected}
				<div class="provider-setup">
					{#if s?.installed && s.authed}
						<p class="provider-auth">{s.authLabel}</p>
					{/if}
					{#if s?.authWarning}
						<p class="provider-warning">
							<Warning size={12} weight="fill" />
							<span>{s.authWarning}</span>
						</p>
					{/if}

					{#if signingInAgent === agent.id}
						<div class="provider-login-terminal">
							<AgentLoginTerminal
								agent={agent.id}
								agentLabel={agent.label}
								onDone={onLoginDone}
								onSkip={endAgentSignIn}
							/>
						</div>
					{:else if install.kind === 'running' && install.agent === agent.id}
						<div class="provider-panel">
							<div class="provider-panel-heading">
								<Spinner size={12} class="motion-essential-spin text-text-muted" />
								<span>Installing {agent.label}</span>
							</div>
							<div class="provider-log">
								{#if install.log.length > 0}
									{#each install.log as line, i (i)}
										<div class="provider-log-line">{line}</div>
									{/each}
								{:else}
									<div class="provider-log-line provider-log-line--muted">Starting installer…</div>
								{/if}
							</div>
						</div>
					{:else if install.kind === 'failed' && install.agent === agent.id}
						<div class="provider-panel provider-panel--error">
							<div class="provider-log">
								{#each install.log as line, i (i)}
									<div class="provider-log-line">{line}</div>
								{/each}
								<div class="provider-log-line provider-log-line--error">{install.error}</div>
							</div>
							<div>
								<Button size="sm" onclick={() => startAgentInstall(agent.id)}>Retry install</Button>
							</div>
						</div>
					{:else if s && !s.installed}
						<div>
							<Button size="sm" onclick={() => startAgentInstall(agent.id)}>Install {agent.label}</Button>
						</div>
					{:else if s && !s.authed && status?.embeddedLoginSupported}
						<div>
							<Button size="sm" onclick={() => startAgentSignIn(agent.id)}>Sign in to {agent.label}</Button>
						</div>
					{:else if s && !s.authed}
						<div class="provider-manual">
							<span>Run this in a terminal, then check again:</span>
							<code>{s.loginCommand ?? `${agent.id} login`}</code>
						</div>
					{:else if s?.installed && s.authed && status?.embeddedLoginSupported}
						<div>
							<Button size="sm" variant="secondary" onclick={() => startAgentSignIn(agent.id)}>
								Reconnect {agent.label}
							</Button>
						</div>
					{/if}
				</div>
			{/if}
		</div>
	{/each}
</RadioGroup.Root>

<style>
	:global(.provider-list) {
		--setting-flash: 0;
		display: flex;
		flex-direction: column;
		background-color: color-mix(
			in srgb,
			var(--color-accent) calc(var(--setting-flash) * 14%),
			transparent
		);
	}

	.provider + .provider {
		border-top: 1px solid var(--color-border-subtle);
	}

	:global(.dark) .provider + .provider {
		border-top-color: var(--color-border);
	}

	:global(.provider-item) {
		display: flex;
		align-items: center;
		gap: 12px;
		width: 100%;
		padding: 12px 16px;
		border: none;
		background: transparent;
		color: inherit;
		font: inherit;
		text-align: left;
		cursor: pointer;
		outline: none;
		transition: background-color var(--duration-quick) var(--ease-out-expo);
	}

	:global(.provider-item:hover) {
		background: color-mix(in srgb, var(--color-text-primary) 3%, transparent);
	}

	:global(.provider-item:focus-visible) {
		box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--color-accent) 40%, transparent);
	}

	.provider-radio {
		width: 14px;
		height: 14px;
		flex-shrink: 0;
		border: 1.5px solid var(--color-text-muted);
		border-radius: 50%;
		background: transparent;
		transition: border-color var(--duration-quick) var(--ease-out-expo);
	}

	.provider-radio--checked {
		border: 4px solid var(--color-accent);
	}

	:global(.provider-icon) {
		flex-shrink: 0;
		color: var(--color-text-secondary);
	}

	.provider-text {
		display: flex;
		min-width: 0;
		flex: 1;
		flex-direction: column;
		gap: 2px;
	}

	.provider-name {
		font-size: 13px;
		color: var(--color-text-primary);
	}

	.provider-description {
		overflow: hidden;
		font-size: 12px;
		color: var(--color-text-secondary);
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.provider-setup {
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 0 16px 14px 42px;
	}

	.provider-setup:empty {
		display: none;
	}

	.provider-auth {
		font-size: 12px;
		color: var(--color-text-secondary);
	}

	.provider-warning {
		display: flex;
		align-items: flex-start;
		gap: 6px;
		max-width: 60ch;
		font-size: 12px;
		line-height: 1.45;
		color: var(--color-warning);
	}

	.provider-panel {
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 12px;
		border: 1px solid var(--color-border-subtle);
		border-radius: 8px;
		background: var(--color-bg-secondary);
	}

	.provider-panel--error {
		border-color: color-mix(in srgb, var(--color-danger) 32%, var(--color-border-subtle));
	}

	.provider-panel-heading {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 12px;
		color: var(--color-text-secondary);
	}

	.provider-log {
		display: flex;
		flex-direction: column;
		gap: 4px;
		max-height: 132px;
		overflow: auto;
		font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
		font-size: 11px;
		line-height: 1.45;
		color: var(--color-text-secondary);
	}

	.provider-log-line {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.provider-log-line--muted {
		color: var(--color-text-muted);
	}

	.provider-log-line--error {
		color: var(--color-danger);
	}

	.provider-manual {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		font-size: 12px;
		color: var(--color-text-secondary);
	}

	.provider-manual code {
		padding: 3px 6px;
		border: 1px solid var(--color-border-subtle);
		border-radius: 6px;
		background: var(--color-bg-secondary);
		color: var(--color-text-primary);
		font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
		font-size: 11.5px;
		overflow-wrap: anywhere;
	}

	.provider-login-terminal {
		--terminal-bg: var(--color-bg-secondary);
		--terminal-surface: var(--color-bg-primary);
		--terminal-border: var(--color-border-subtle);
		--terminal-error-border: var(--color-danger);
		--terminal-fg: var(--color-text-primary);
		--terminal-heading: var(--color-text-primary);
		--terminal-body: var(--color-text-secondary);
		--terminal-muted: var(--color-text-muted);
		--terminal-dim: var(--color-text-muted);
		--terminal-accent: var(--color-accent);
		--terminal-danger: var(--color-danger);
		--terminal-selection: color-mix(in srgb, var(--color-accent) 14%, transparent);
		padding: 12px;
		border: 1px solid var(--color-border-subtle);
		border-radius: 8px;
		background: var(--color-bg-secondary);
	}
</style>
