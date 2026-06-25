<script lang="ts">
import {
  ACP_AGENTS,
  type AcpAgentId,
  type AgentStatusReport,
  type InstallEvent,
} from "@revv/shared";
import ChevronLeft from "phosphor-svelte/lib/CaretLeft";
import { onDestroy, onMount } from "svelte";
import { API_BASE_URL } from "$lib/api/base-url";
import { acpAgentIcon } from "$lib/components/icons/acpAgentIcon";
import Dotmatrix from "$lib/components/ui/dotmatrix/Dotmatrix.svelte";
import {
  cascadeChatAgentChange,
  fetchAgentStatus,
  fetchModels,
  getAgentStatus,
  getSettings,
  resolveChatAgentId,
  updateSettings,
} from "$lib/stores/settings.svelte";
import { authHeaders } from "$lib/utils/session-token";
import { parseSSEBuffer } from "$lib/utils/sse-parser";
import AgentLoginTerminal from "./AgentLoginTerminal.svelte";

interface Props {
  onContinue: () => void;
  onBack?: () => void;
  /** Skip without changing the saved agent. */
  onSkip?: () => void;
}

let { onContinue, onBack, onSkip }: Props = $props();

const OPENCODE: AcpAgentId = "opencode";
const LOG_TAIL = 6;

// ── State ──────────────────────────────────────────────────────────────────
//
// `mode` gates the loading screen vs. the picker. `status` is the server's
// one-shot detection snapshot (per-agent installed + authed + login command,
// plus whether this host can drive the embedded PTY login). `install` is a
// tagged request-state union; `signingIn` is the agent whose embedded sign-in
// terminal is mounted. The adaptive CTA is derived from all three (see `cta`).
type InstallState =
  | { kind: "idle" }
  | { kind: "running"; agent: AcpAgentId; log: string[] }
  | { kind: "failed"; agent: AcpAgentId; log: string[]; error: string };

let mode = $state<"loading" | "picker">("loading");
let status = $state<AgentStatusReport | null>(null);
let install = $state<InstallState>({ kind: "idle" });
let signingIn = $state<AcpAgentId | null>(null);
let isSaving = $state(false);
let installAbort: AbortController | null = null;

// Picker selection: pre-select the current chat agent, falling back to opencode
// if the settings haven't loaded or the saved agent isn't installed.
let selected = $state<AcpAgentId>(resolveChatAgentId(getSettings()));

// ── Derived ──────────────────────────────────────────────────────────────
const selectedInstalled = $derived(status?.agents[selected]?.installed ?? false);
// When detection hasn't resolved (null) treat the selection as authed so a
// probe failure never blocks Continue.
const selectedAuthed = $derived(status ? (status.agents[selected]?.authed ?? false) : true);
const selectedLabel = $derived(ACP_AGENTS.find((a) => a.id === selected)?.label ?? selected);
// Manual login command for the no-embedded-PTY fallback — server-provided, so
// there's a single source of truth for each agent's login command.
const selectedLoginCommand = $derived(
  status?.agents[selected]?.loginCommand ?? `${selected} login`,
);
// True once detection resolved and nothing is installed — we advertise opencode
// (pre-selected, free / no sign-in) as the zero-config option.
const noneInstalled = $derived(
  status !== null && !ACP_AGENTS.some((a) => status?.agents[a.id]?.installed),
);

// The single adaptive CTA state — one tagged value instead of an order-dependent
// boolean ladder, so each arm's precondition is explicit and self-contained.
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
  if (install.kind === "running") return { kind: "installing" };
  if (install.kind === "failed") return { kind: "install-failed" };
  if (!selectedInstalled) return { kind: "needs-install" };
  if (selectedAuthed) return { kind: "ready" };
  // Installed but not authed: embedded PTY login where the host supports it
  // (the server is the authority), else a manual-command hint.
  return status?.embeddedLoginSupported ? { kind: "needs-login" } : { kind: "needs-login-manual" };
});

onMount(async () => {
  const data = getAgentStatus() ?? (await fetchAgentStatus());
  status = data;
  if (!data) {
    // Detection failed — fall back to picker so the user isn't stuck.
    mode = "picker";
    return;
  }
  const installed = ACP_AGENTS.filter((a) => data.agents[a.id]?.installed);
  if (installed.length > 0) {
    // If the saved agent isn't installed, nudge the selection to the first
    // installed agent (registry order) so Continue doesn't pick a missing CLI.
    const saved = resolveChatAgentId(getSettings());
    selected = data.agents[saved]?.installed ? saved : (installed[0]?.id ?? selected);
  } else {
    // Nothing installed — advertise opencode as the out-of-the-box option.
    selected = OPENCODE;
  }
  mode = "picker";
});

onDestroy(() => {
  installAbort?.abort();
});

async function handleContinue(): Promise<void> {
  isSaving = true;
  try {
    // opencode's catalog is dynamic — kick off a fetch so the cascade can pick a
    // real default model. Other agents have static catalogs in the registry.
    if (selected === OPENCODE) void fetchModels("opencode");
    await updateSettings(cascadeChatAgentChange(selected));
    onContinue();
  } finally {
    isSaving = false;
  }
}

async function handleInstall(agent: AcpAgentId): Promise<void> {
  install = { kind: "running", agent, log: [] };
  try {
    const startRes = await fetch(`${API_BASE_URL}/api/onboarding/install`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ agent }),
    });
    if (!startRes.ok) {
      install = {
        kind: "failed",
        agent,
        log: currentLog(),
        error: `Failed to start installer (HTTP ${startRes.status})`,
      };
      return;
    }
    const { jobId } = (await startRes.json()) as { jobId: string };

    const ctrl = new AbortController();
    installAbort = ctrl;
    await streamInstallEvents(jobId, agent, ctrl.signal);
  } catch (err) {
    if ((err as Error)?.name === "AbortError") return;
    install = {
      kind: "failed",
      agent,
      log: currentLog(),
      error: err instanceof Error ? err.message : "Install failed",
    };
  } finally {
    installAbort = null;
  }
}

/** Lines accumulated so far, preserved across a running → failed transition. */
function currentLog(): string[] {
  return install.kind === "idle" ? [] : install.log;
}

async function streamInstallEvents(
  jobId: string,
  agent: AcpAgentId,
  signal: AbortSignal,
): Promise<void> {
  const url = `${API_BASE_URL}/api/onboarding/install/stream?jobId=${encodeURIComponent(jobId)}`;
  const res = await fetch(url, { headers: authHeaders(), signal });
  if (!res.ok || !res.body) {
    install = {
      kind: "failed",
      agent,
      log: currentLog(),
      error: `Stream failed (HTTP ${res.status})`,
    };
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const result = parseSSEBuffer<InstallEvent>(buffer);
    buffer = result.remaining;
    for (const event of result.events) applyInstallEvent(event, agent);
    if (result.done) break;
  }
}

function applyInstallEvent(event: InstallEvent, agent: AcpAgentId): void {
  if (event.type === "log") {
    if (install.kind === "running") {
      install = { kind: "running", agent, log: [...install.log, event.line].slice(-LOG_TAIL) };
    }
    return;
  }
  // done
  if (!event.success) {
    install = { kind: "failed", agent, log: currentLog(), error: event.error ?? "Install failed" };
    return;
  }
  // Success — refresh detection so the just-installed agent shows the Installed
  // tag. If it still needs a login and the host supports the embedded PTY,
  // advance straight to sign-in; otherwise the CTA flips to Continue (or the
  // manual hint where the embedded login isn't available).
  void (async () => {
    const data = await fetchAgentStatus();
    status = data;
    install = { kind: "idle" };
    if (data && data.agents[agent]?.authed === false && data.embeddedLoginSupported) {
      signingIn = agent;
    }
  })();
}

function handleSignIn(agent: AcpAgentId): void {
  signingIn = agent;
}

async function onLoginDone(): Promise<void> {
  // The CLI reported a verified login — refresh the snapshot so the CTA flips to
  // Continue, then drop the terminal.
  status = await fetchAgentStatus();
  signingIn = null;
}

function onLoginSkip(): void {
  // Unmounting the terminal triggers its onDestroy, which kills the server PTY.
  signingIn = null;
}

function handleSkip(): void {
  installAbort?.abort();
  if (onSkip) onSkip();
  else onContinue();
}
</script>

<div class="agent">
	{#if onBack}
		<button class="back" onclick={onBack}>
			<ChevronLeft size={14} />
			<span>Back</span>
		</button>
	{/if}

	{#if mode === 'loading'}
		<p class="lede">Detecting installed agents…</p>
	{:else}
		<p class="lede">
			{#if noneInstalled}
				No agent is set up on this machine yet. <em>opencode</em> is free,
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
					style="--option-index: {i}"
				>
					<input
						type="radio"
						name="agent"
						value={agent.id}
						bind:group={selected}
						disabled={install.kind === 'running' || signingIn !== null}
					/>
					<span class="option-mark" aria-hidden="true"></span>
					<span class="option-icon" aria-hidden="true">
						<AgentIcon size={20} />
					</span>
					<span class="option-body">
						<span class="option-row">
							<span class="option-name">{agent.label}</span>
							{#if isInstalled}
								<span class="option-tag tag-installed">installed</span>
							{:else if agent.id === OPENCODE}
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
				onSkip={onLoginSkip}
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
			<div class="install-actions">
				<button class="primary" onclick={() => handleInstall(selected)}>
					<span>Retry</span>
				</button>
				<button class="secondary" onclick={handleSkip}>Skip for now</button>
			</div>
		{:else if cta.kind === 'ready'}
			<div class="actions">
				<button class="primary" onclick={handleContinue} disabled={isSaving}>
					<span>Continue</span>
					<svg
						width="18"
						height="10"
						viewBox="0 0 18 10"
						fill="none"
						xmlns="http://www.w3.org/2000/svg"
						aria-hidden="true"
					>
						<path d="M0 5h16M12 1l4 4-4 4" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" />
					</svg>
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
			<div class="install-actions">
				<button class="primary" onclick={handleContinue} disabled={isSaving}>
					<span>Continue</span>
				</button>
				<button class="secondary" onclick={handleSkip}>Skip for now</button>
			</div>
		{:else if cta.kind === 'needs-login'}
			<div class="install-actions">
				<button class="primary" onclick={() => handleSignIn(selected)}>
					<span>Sign in to {selectedLabel}</span>
				</button>
				<button class="secondary" onclick={handleSkip}>Skip for now</button>
			</div>
		{:else}
			<div class="install-actions">
				<button class="primary" onclick={() => handleInstall(selected)}>
					<span>Install {selectedLabel}</span>
				</button>
				<button class="secondary" onclick={handleSkip}>Skip for now</button>
			</div>
		{/if}
	{/if}
</div>

<style>
	.agent {
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
		animation: option-in var(--duration-ceremonial-medium) var(--ease-out-expo) backwards;
		animation-delay: calc(var(--option-index, 0) * 80ms);
	}

	@keyframes option-in {
		from {
			opacity: 0;
			transform: translateY(6px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
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

	.option[data-selected='true'] .option-mark::after {
		content: '';
		position: absolute;
		inset: 3px;
		border-radius: 50%;
		background: var(--ob-text-italic);
		animation: mark-pop var(--duration-slow) var(--ease-out-expo);
	}

	@keyframes mark-pop {
		from {
			transform: scale(0);
		}
		to {
			transform: scale(1);
		}
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
		animation: actions-in var(--duration-ceremonial-medium) var(--ease-out-expo) 240ms backwards;
	}

	@keyframes actions-in {
		from {
			opacity: 0;
			transform: translateY(6px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
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

	.primary svg {
		transition: transform var(--duration-slow) var(--ease-out-expo);
	}

	.primary:hover:not(:disabled) {
		border-color: var(--ob-text-italic);
		color: var(--ob-text-heading-bright);
	}

	.primary:hover:not(:disabled) svg {
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

	@media (prefers-reduced-motion: reduce) {
		.option,
		.option[data-selected='true'] .option-mark::after,
		.actions,
		.install-actions {
			animation: none !important;
		}
	}
</style>
