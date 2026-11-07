<script lang="ts">
import { ACP_AGENTS, type AcpAgentId, getAcpAgent } from "@revv/shared";
import CaretLeft from "phosphor-svelte/lib/CaretLeft";
import { onDestroy, onMount } from "svelte";
import { agentReadiness } from "$lib/agent-setup/readiness";
import {
  endAgentSignIn,
  getAgentInstall,
  getSigningInAgent,
  resetAgentSetup,
  selectAgent,
  startAgentInstall,
  startAgentSignIn,
} from "$lib/agent-setup/store.svelte";
import AgentLoginTerminal from "$lib/components/agent-setup/AgentLoginTerminal.svelte";
import { acpAgentIcon } from "$lib/components/icons/acpAgentIcon";
import Dotmatrix from "$lib/components/ui/dotmatrix/Dotmatrix.svelte";
import { gsapEnter } from "$lib/motion";
import { fetchAgentStatus, getAgentStatus, getSettings } from "$lib/stores/settings.svelte";
import ContinueArrow from "./ContinueArrow.svelte";
import { ACTIONS_IN, MARK_POP, OPTION_IN } from "./motion";

interface Props {
  onContinue: () => void;
  onBack?: () => void;
  /** Skip without changing the saved agent. */
  onSkip?: () => void;
}

let { onContinue, onBack, onSkip }: Props = $props();

/** The agent that works without a sign-in, offered when nothing is installed. */
const ZERO_CONFIG = ACP_AGENTS.find((a) => needsNoSignIn(a.id));

function needsNoSignIn(agent: AcpAgentId): boolean {
  return getAcpAgent(agent).cli.loginArgs === null;
}

let mode = $state<"loading" | "picker">("loading");
let isSaving = $state(false);
const status = $derived(getAgentStatus());
const install = $derived(getAgentInstall());
const signingIn = $derived(getSigningInAgent());

// Picker selection: the current chat agent until detection says otherwise.
let selected = $state<AcpAgentId>(getSettings().aiAgent);

const selectedReadiness = $derived(agentReadiness(status?.agents[selected]));
const selectedLabel = $derived(ACP_AGENTS.find((a) => a.id === selected)?.label ?? selected);
const selectedLoginCommand = $derived(
  status?.agents[selected]?.loginCommand ?? `${selected} login`,
);
const noneInstalled = $derived(
  status !== null && !ACP_AGENTS.some((a) => status?.agents[a.id]?.installed),
);

type CtaState =
  | { kind: "signing-in"; agent: AcpAgentId }
  | { kind: "installing" }
  | { kind: "install-failed" }
  | { kind: "ready" }
  | { kind: "needs-login" }
  | { kind: "needs-login-manual" }
  | { kind: "needs-install" };

const cta = $derived.by((): CtaState => {
  if (signingIn !== null) return { kind: "signing-in", agent: signingIn };
  if (install.kind === "running" && install.agent === selected) return { kind: "installing" };
  if (install.kind === "failed" && install.agent === selected) return { kind: "install-failed" };
  if (selectedReadiness.ready) return { kind: "ready" };
  if (selectedReadiness.needs !== "sign-in") return { kind: "needs-install" };
  // Embedded PTY login where the host supports it (the server is the
  // authority), else a manual-command hint.
  return status?.embeddedLoginSupported ? { kind: "needs-login" } : { kind: "needs-login-manual" };
});

onMount(async () => {
  const data = getAgentStatus() ?? (await fetchAgentStatus());
  if (!data) {
    // Detection failed — fall back to picker so the user isn't stuck.
    mode = "picker";
    return;
  }
  const installed = ACP_AGENTS.filter((a) => data.agents[a.id]?.installed);
  if (installed.length > 0) {
    // If the saved agent isn't installed, nudge the selection to the first
    // installed agent (registry order) so Continue doesn't pick a missing CLI.
    const saved = getSettings().aiAgent;
    selected = data.agents[saved]?.installed ? saved : (installed[0]?.id ?? selected);
  } else if (ZERO_CONFIG) {
    selected = ZERO_CONFIG.id;
  }
  mode = "picker";
});

// Leaving the step abandons an install; unmounting the terminal kills a sign-in.
onDestroy(resetAgentSetup);

async function handleContinue(): Promise<void> {
  isSaving = true;
  try {
    await selectAgent(selected);
    onContinue();
  } finally {
    isSaving = false;
  }
}

async function onLoginDone(): Promise<void> {
  await fetchAgentStatus();
  endAgentSignIn();
}

function handleSkip(): void {
  resetAgentSetup();
  if (onSkip) onSkip();
  else onContinue();
}
</script>

<div class="agent">
	{#if onBack}
		<button class="back" onclick={onBack}>
			<CaretLeft size={14} />
			<span>Back</span>
		</button>
	{/if}

	{#if mode === 'loading'}
		<p class="lede">Detecting installed agents…</p>
	{:else}
		<p class="lede">
			{#if noneInstalled && ZERO_CONFIG}
				No agent is set up on this machine yet. <em>{ZERO_CONFIG.label}</em> is free,
				open-source, and works out of the box — no sign-in needed. Start with it,
				or install another agent below.
			{:else}
				Choose the agent that reads your pull requests. You can swap engines later
				from settings.
			{/if}
		</p>

		<fieldset class="options">
			<legend class="visually-hidden">AI agent</legend>

			{#each ACP_AGENTS as agent, i (agent.id)}
				{@const AgentIcon = acpAgentIcon(agent.icon)}
				{@const isInstalled = status?.agents[agent.id]?.installed ?? false}
				<label
					class="option"
					data-selected={selected === agent.id}
					use:gsapEnter={{ ...OPTION_IN, delay: i * 0.08 }}
				>
					<input
						type="radio"
						name="agent"
						value={agent.id}
						bind:group={selected}
						disabled={install.kind === 'running' || signingIn !== null}
					/>
					<span class="option-mark" aria-hidden="true">
						{#if selected === agent.id}<span class="option-dot" use:gsapEnter={MARK_POP}></span>{/if}
					</span>
					<span class="option-icon" aria-hidden="true">
						<AgentIcon size={20} />
					</span>
					<span class="option-body">
						<span class="option-row">
							<span class="option-name">{agent.label}</span>
							{#if isInstalled}
								<span class="option-tag tag-installed">installed</span>
							{:else if needsNoSignIn(agent.id)}
								<span class="option-tag tag-free">free · no sign-in</span>
							{:else}
								<span class="option-tag tag-missing">needs sign-in</span>
							{/if}
						</span>
						<span class="option-host">{agent.description}</span>
					</span>
				</label>
			{/each}
		</fieldset>

		{#if cta.kind === 'signing-in'}
			<AgentLoginTerminal
				agent={cta.agent}
				agentLabel={ACP_AGENTS.find((a) => a.id === cta.agent)?.label ?? cta.agent}
				onDone={onLoginDone}
				onSkip={endAgentSignIn}
			/>
		{:else if cta.kind === 'installing'}
			<div class="installing">
				<Dotmatrix variant="square-7" />
				<div class="install-log">
					{#if install.kind === 'running' && install.log.length > 0}
						{#each install.log as line, i (i)}
							<div class="log-line">{line}</div>
						{/each}
					{:else}
						<div class="log-line log-muted">Starting installer…</div>
					{/if}
				</div>
				<button class="secondary" onclick={handleSkip}>Skip waiting</button>
			</div>
		{:else if cta.kind === 'install-failed' && install.kind === 'failed'}
			<div class="install-log error">
				{#each install.log as line, i (i)}
					<div class="log-line">{line}</div>
				{/each}
				<div class="log-line log-error">{install.error}</div>
			</div>
			<div class="install-actions" use:gsapEnter={ACTIONS_IN}>
				<button class="primary" onclick={() => startAgentInstall(selected)}>
					<span>Retry</span>
				</button>
				<button class="secondary" onclick={handleSkip}>Skip for now</button>
			</div>
		{:else if cta.kind === 'ready'}
			<div class="actions" use:gsapEnter={ACTIONS_IN}>
				<button class="primary" onclick={handleContinue} disabled={isSaving}>
					<span>Continue</span>
					<ContinueArrow />
				</button>
			</div>
		{:else if cta.kind === 'needs-login-manual'}
			<div class="win-hint">
				<p class="win-hint-text">
					Signing in from inside Revv isn't available on this platform yet. Open a
					terminal and run this to sign in to <em>{selectedLabel}</em>, then come
					back and continue:
				</p>
				<code class="win-hint-cmd">{selectedLoginCommand}</code>
			</div>
			<div class="install-actions" use:gsapEnter={ACTIONS_IN}>
				<button class="primary" onclick={handleContinue} disabled={isSaving}>
					<span>Continue</span>
				</button>
				<button class="secondary" onclick={handleSkip}>Skip for now</button>
			</div>
		{:else if cta.kind === 'needs-login'}
			<div class="install-actions" use:gsapEnter={ACTIONS_IN}>
				<button class="primary" onclick={() => startAgentSignIn(selected)}>
					<span>Sign in to {selectedLabel}</span>
				</button>
				<button class="secondary" onclick={handleSkip}>Skip for now</button>
			</div>
		{:else}
			<div class="install-actions" use:gsapEnter={ACTIONS_IN}>
				<button class="primary" onclick={() => startAgentInstall(selected)}>
					<span>Install {selectedLabel}</span>
				</button>
				<button class="secondary" onclick={handleSkip}>Skip for now</button>
			</div>
		{/if}
	{/if}
</div>

<style>
	.agent {
		--terminal-bg: var(--ob-bg);
		--terminal-surface: var(--ob-hover-subtle);
		--terminal-border: var(--ob-border);
		--terminal-error-border: var(--ob-text-label);
		--terminal-fg: var(--ob-text);
		--terminal-heading: var(--ob-text-heading);
		--terminal-body: var(--ob-text-body);
		--terminal-muted: var(--ob-text-muted);
		--terminal-dim: var(--ob-text-dimmed);
		--terminal-accent: var(--ob-text-italic);
		--terminal-danger: var(--ob-error);
		--terminal-selection: var(--ob-row-highlight);
		display: flex;
		flex-direction: column;
		gap: 32px;
		max-width: 520px;
	}

	.back {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		align-self: flex-start;
		background: none;
		border: 0;
		padding: 0;
		color: var(--ob-text-muted);
		font-family: var(--font-mono, 'JetBrains Mono', monospace);
		font-size: 10.5px;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		cursor: pointer;
		transition: color var(--duration-snap) var(--ease-out-expo);
		margin-bottom: -12px;
	}

	.back:hover {
		color: var(--ob-text-italic);
	}

	.back :global(svg) {
		transition: transform var(--duration-quick) var(--ease-out-expo);
	}

	.back:hover :global(svg) {
		transform: translateX(-3px);
	}

	.lede {
		font-family: 'Newsreader', Georgia, serif;
		font-size: 17px;
		font-weight: 400;
		line-height: 1.6;
		color: var(--ob-text-body);
		margin: 0;
	}

	.options {
		display: flex;
		flex-direction: column;
		gap: 0;
		margin: 0;
		padding: 0;
		border: 0;
		border-top: 1px solid var(--ob-border);
	}

	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}

	.option {
		display: flex;
		align-items: center;
		gap: 16px;
		padding: 18px 4px;
		border-bottom: 1px solid var(--ob-border);
		cursor: pointer;
		transition: background-color var(--duration-snap) var(--ease-out-expo);
	}

	.option:hover {
		background: var(--ob-hover-subtle);
	}

	.option input {
		position: absolute;
		opacity: 0;
		pointer-events: none;
	}

	.option-mark {
		position: relative;
		flex-shrink: 0;
		width: 14px;
		height: 14px;
		border: 1px solid var(--ob-border-btn);
		border-radius: 50%;
		transition: border-color var(--duration-snap) var(--ease-out-expo);
	}

	.option[data-selected='true'] .option-mark {
		border-color: var(--ob-text-italic);
	}

	.option-dot {
		position: absolute;
		inset: 3px;
		border-radius: 50%;
		background: var(--ob-text-italic);
	}

	.option-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		width: 24px;
		height: 24px;
		color: var(--ob-text-muted);
	}

	.option[data-selected='true'] .option-icon {
		color: var(--ob-text-italic);
	}

	.option-body {
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.option-row {
		display: flex;
		align-items: baseline;
		gap: 12px;
	}

	.option-name {
		font-family: 'Newsreader', Georgia, serif;
		font-size: 20px;
		color: var(--ob-text-heading);
		letter-spacing: -0.005em;
	}

	.option[data-selected='true'] .option-name {
		font-style: italic;
	}

	.option-tag {
		font-family: var(--font-mono, 'JetBrains Mono', monospace);
		font-size: 9.5px;
		letter-spacing: 0.18em;
		text-transform: uppercase;
	}

	.tag-installed {
		color: var(--ob-text-italic);
	}

	.tag-free {
		color: var(--ob-text-italic);
	}

	.tag-missing {
		color: var(--ob-text-label);
	}

	.option-host {
		font-family: var(--font-mono, 'JetBrains Mono', monospace);
		font-size: 12px;
		color: var(--ob-text-muted);
	}

	.actions,
	.install-actions {
		display: flex;
		justify-content: flex-end;
		align-items: center;
		gap: 18px;
	}

	.primary {
		display: inline-flex;
		align-items: center;
		gap: 14px;
		padding: 12px 22px;
		border: 1px solid var(--ob-border-btn);
		border-radius: 2px;
		background: transparent;
		color: var(--ob-text-heading);
		font-family: 'Newsreader', Georgia, serif;
		font-style: italic;
		font-size: 16px;
		font-weight: 500;
		cursor: pointer;
		letter-spacing: 0.01em;
		transition:
			background-color var(--duration-snap) var(--ease-out-expo),
			border-color var(--duration-snap) var(--ease-out-expo),
			color var(--duration-snap) var(--ease-out-expo),
			transform var(--duration-smooth) var(--ease-out-expo);
	}

	.primary :global(svg) {
		transition: transform var(--duration-slow) var(--ease-out-expo);
	}

	.primary:hover:not(:disabled) {
		border-color: var(--ob-text-italic);
		color: var(--ob-text-heading-bright);
	}

	.primary:hover:not(:disabled) :global(svg) {
		transform: translateX(4px);
	}

	.primary:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.secondary {
		background: none;
		border: 0;
		padding: 8px 4px;
		color: var(--ob-text-muted);
		font-family: var(--font-mono, 'JetBrains Mono', monospace);
		font-size: 10.5px;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		cursor: pointer;
		transition: color var(--duration-snap) var(--ease-out-expo);
	}

	.secondary:hover {
		color: var(--ob-text-italic);
	}

	.installing {
		display: flex;
		flex-direction: column;
		align-items: stretch;
		gap: 20px;
	}

	.installing :global(.dotmatrix) {
		align-self: center;
	}

	.install-log {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 14px 16px;
		border: 1px solid var(--ob-border);
		border-radius: 2px;
		background: var(--ob-hover-subtle);
		font-family: var(--font-mono, 'JetBrains Mono', monospace);
		font-size: 11.5px;
		line-height: 1.45;
		color: var(--ob-text-body);
		max-height: 160px;
		overflow: hidden;
	}

	.install-log.error {
		border-color: var(--ob-text-label);
	}

	.log-line {
		white-space: pre-wrap;
		word-break: break-all;
	}

	.log-muted {
		color: var(--ob-text-muted);
	}

	.log-error {
		color: var(--ob-text-italic);
	}

	.win-hint {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.win-hint-text {
		font-family: 'Newsreader', Georgia, serif;
		font-size: 15px;
		line-height: 1.6;
		color: var(--ob-text-body);
		margin: 0;
	}

	.win-hint-text em {
		font-style: italic;
		color: var(--ob-text-italic);
	}

	.win-hint-cmd {
		align-self: flex-start;
		padding: 10px 14px;
		border: 1px solid var(--ob-border);
		border-radius: 2px;
		background: var(--ob-hover-subtle);
		font-family: var(--font-mono, 'JetBrains Mono', monospace);
		font-size: 12.5px;
		color: var(--ob-text-heading);
		user-select: all;
	}
</style>
