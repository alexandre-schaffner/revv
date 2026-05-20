<script lang="ts">
import ChevronLeft from "phosphor-svelte/lib/CaretLeft";
import type { AgentAvailability, AiAgent, InstallEvent } from "@revv/shared";
import { onDestroy, onMount } from "svelte";
import { API_BASE_URL } from "$lib/api/base-url";
import AnthropicIcon from "$lib/components/icons/AnthropicIcon.svelte";
import OpenCodeIcon from "$lib/components/icons/OpenCodeIcon.svelte";
import Dotmatrix from "$lib/components/ui/dotmatrix/Dotmatrix.svelte";
import {
  cascadeAgentChange,
  fetchAgentAvailability,
  fetchModels,
  getAgentAvailability,
  getSettings,
  updateSettings,
} from "$lib/stores/settings.svelte";
import { authHeaders } from "$lib/utils/session-token";
import { parseSSEBuffer } from "$lib/utils/sse-parser";

interface Props {
  onContinue: () => void;
  onBack?: () => void;
  /** Skip without changing the saved agent. */
  onSkip?: () => void;
}

let { onContinue, onBack, onSkip }: Props = $props();

const OPENCODE: AiAgent = "opencode";
const CLAUDE: AiAgent = "claude";

const TAGLINES: Record<AiAgent, string> = {
  opencode: "Local engine, works out of the box.",
  claude: "Anthropic's reasoning model.",
};

// ── Detection state ──────────────────────────────────────────────────────
//
// Three rendering modes:
//   - 'loading' — initial detection in flight
//   - 'picker'  — at least one provider detected, user picks one
//   - 'install' — neither detected, offer to install opencode
let mode = $state<"loading" | "picker" | "install">("loading");
let availability = $state<AgentAvailability | null>(null);

// Picker state: pre-select the currently saved agent, falling back to
// opencode if either the settings haven't loaded or the saved agent isn't
// installed (rare — but if so, prefer the installed one over the empty
// pre-selection).
let selected = $state<AiAgent>(
  ((getSettings()?.aiAgent as AiAgent | undefined) ?? OPENCODE) as AiAgent,
);
let isSaving = $state(false);

// Install state.
let installJobId = $state<string | null>(null);
let installLog = $state<string[]>([]);
let installFailed = $state(false);
let installError = $state<string | null>(null);
let installAbort: AbortController | null = null;
const LOG_TAIL = 6;

onMount(async () => {
  const cached = getAgentAvailability();
  const data = cached ?? (await fetchAgentAvailability());
  availability = data;
  if (!data) {
    // Detection failed — fall back to picker so the user isn't stuck.
    mode = "picker";
    return;
  }
  if (data.opencode || data.claude) {
    // If the saved agent isn't installed, nudge the selection to whichever
    // IS installed so Continue doesn't pick a missing CLI.
    const saved = (getSettings()?.aiAgent as AiAgent | undefined) ?? OPENCODE;
    if (saved === OPENCODE && !data.opencode && data.claude) {
      selected = CLAUDE;
    } else if (saved === CLAUDE && !data.claude && data.opencode) {
      selected = OPENCODE;
    } else {
      selected = saved;
    }
    mode = "picker";
  } else {
    mode = "install";
  }
});

onDestroy(() => {
  installAbort?.abort();
});

async function handleContinue(): Promise<void> {
  isSaving = true;
  try {
    void fetchModels(selected);
    await updateSettings(cascadeAgentChange(selected));
    onContinue();
  } finally {
    isSaving = false;
  }
}

async function handleInstall(): Promise<void> {
  installFailed = false;
  installError = null;
  installLog = [];

  try {
    const startRes = await fetch(`${API_BASE_URL}/api/onboarding/install-opencode`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
    });
    if (!startRes.ok) {
      installFailed = true;
      installError = `Failed to start installer (HTTP ${startRes.status})`;
      return;
    }
    const { jobId } = (await startRes.json()) as { jobId: string };
    installJobId = jobId;

    const ctrl = new AbortController();
    installAbort = ctrl;
    await streamInstallEvents(jobId, ctrl.signal);
  } catch (err) {
    if ((err as Error)?.name === "AbortError") return;
    installFailed = true;
    installError = err instanceof Error ? err.message : "Install failed";
  } finally {
    installAbort = null;
  }
}

async function streamInstallEvents(jobId: string, signal: AbortSignal): Promise<void> {
  const url = `${API_BASE_URL}/api/onboarding/install-opencode/stream?jobId=${encodeURIComponent(jobId)}`;
  const res = await fetch(url, { headers: authHeaders(), signal });
  if (!res.ok || !res.body) {
    installFailed = true;
    installError = `Stream failed (HTTP ${res.status})`;
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
    for (const event of result.events) {
      applyEvent(event);
    }
    if (result.done) break;
  }
}

function applyEvent(event: InstallEvent): void {
  if (event.type === "log") {
    installLog = [...installLog, event.line].slice(-LOG_TAIL);
    return;
  }
  if (event.type === "done") {
    if (event.success) {
      // Refresh detection so the picker pre-selects opencode and shows
      // the Installed tag accurately.
      void (async () => {
        const fresh = await fetchAgentAvailability();
        availability = fresh;
        selected = OPENCODE;
        mode = "picker";
      })();
    } else {
      installFailed = true;
      installError = event.error ?? "Install failed";
    }
  }
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
	{:else if mode === 'picker'}
		<p class="lede">
			Choose the agent that reads your pull requests. You can swap engines later
			from settings.
		</p>

		<fieldset class="options">
			<legend class="visually-hidden">AI agent</legend>

			<label class="option" data-selected={selected === OPENCODE}>
				<input type="radio" name="agent" value={OPENCODE} bind:group={selected} />
				<span class="option-mark" aria-hidden="true"></span>
				<span class="option-icon" aria-hidden="true">
					<OpenCodeIcon size={20} />
				</span>
				<span class="option-body">
					<span class="option-row">
						<span class="option-name">OpenCode</span>
						{#if availability?.opencode}
							<span class="option-tag tag-installed">installed</span>
						{:else}
							<span class="option-tag tag-missing">not installed</span>
						{/if}
					</span>
					<span class="option-host">{TAGLINES.opencode}</span>
				</span>
			</label>

			<label class="option" data-selected={selected === CLAUDE}>
				<input type="radio" name="agent" value={CLAUDE} bind:group={selected} />
				<span class="option-mark" aria-hidden="true"></span>
				<span class="option-icon" aria-hidden="true">
					<AnthropicIcon size={20} />
				</span>
				<span class="option-body">
					<span class="option-row">
						<span class="option-name">Claude Code</span>
						{#if availability?.claude}
							<span class="option-tag tag-installed">installed</span>
						{:else}
							<span class="option-tag tag-missing">not installed</span>
						{/if}
					</span>
					<span class="option-host">{TAGLINES.claude}</span>
				</span>
			</label>
		</fieldset>

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
	{:else}
		<p class="lede">
			No AI agent was found on this machine. Install OpenCode to run reviews
			locally — it ships as a single binary and takes about a minute.
		</p>

		{#if installJobId === null && !installFailed}
			<div class="install-actions">
				<button class="primary" onclick={handleInstall}>
					<span>Install OpenCode</span>
				</button>
				<button class="secondary" onclick={handleSkip}>Skip for now</button>
			</div>
		{:else if installFailed}
			<div class="install-log error">
				{#each installLog as line, i (i)}
					<div class="log-line">{line}</div>
				{/each}
				<div class="log-line log-error">{installError ?? 'Install failed.'}</div>
			</div>
			<div class="install-actions">
				<button class="primary" onclick={handleInstall}>
					<span>Retry</span>
				</button>
				<button class="secondary" onclick={handleSkip}>Skip for now</button>
			</div>
		{:else}
			<div class="installing">
				<Dotmatrix variant="square-7" />
				<div class="install-log">
					{#if installLog.length === 0}
						<div class="log-line log-muted">Starting installer…</div>
					{:else}
						{#each installLog as line, i (i)}
							<div class="log-line">{line}</div>
						{/each}
					{/if}
				</div>
				<button class="secondary" onclick={handleSkip}>Skip waiting</button>
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
	}

	.option:nth-child(2) {
		animation-delay: 80ms;
	}

	.option:nth-child(3) {
		animation-delay: 160ms;
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

	@media (prefers-reduced-motion: reduce) {
		.option,
		.option[data-selected='true'] .option-mark::after,
		.actions,
		.install-actions {
			animation: none !important;
		}
	}
</style>
