<script lang="ts">
import ChevronLeft from "phosphor-svelte/lib/CaretLeft";
import {
  cancelSignIn,
  clearToken,
  getIsAuthenticated,
  setForceOnboardingFlow,
} from "$lib/stores/auth.svelte";
import { getGithubHost, setGithubHost } from "$lib/stores/settings.svelte";

interface Props {
  onContinue: () => void;
  onBack?: () => void;
}

let { onContinue, onBack }: Props = $props();

const NOCTURLAB = "nocturlab.ghe.com";
const PUBLIC = "github.com";

let selected = $state<string>(getGithubHost() ?? NOCTURLAB);
let isSaving = $state(false);

async function handleContinue() {
  const previousHost = getGithubHost();
  const hostChanged = previousHost !== null && previousHost !== selected;

  if (hostChanged && getIsAuthenticated()) {
    // Suppress the AccountPicker — we're still inside the onboarding
    // flow and about to re-authenticate with the new host.
    setForceOnboardingFlow();
    cancelSignIn();
    clearToken();
  }

  isSaving = true;
  try {
    await setGithubHost(selected);
    onContinue();
  } finally {
    isSaving = false;
  }
}
</script>

<div class="host">
	{#if onBack}
		<button class="back" onclick={onBack}>
			<ChevronLeft size={14} />
			<span>Back</span>
		</button>
	{/if}

	<p class="lede">
		Tell Revv where your repositories live. You can change this later in
		settings.
	</p>

	<fieldset class="options">
		<legend class="visually-hidden">GitHub host</legend>

		<label class="option" data-selected={selected === NOCTURLAB}>
			<input type="radio" name="host" value={NOCTURLAB} bind:group={selected} />
			<span class="option-mark" aria-hidden="true"></span>
			<span class="option-body">
				<span class="option-row">
					<span class="option-name">Nocturlab</span>
					<span class="option-tag">recommended</span>
				</span>
				<span class="option-host">{NOCTURLAB}</span>
			</span>
		</label>

		<label class="option" data-selected={selected === PUBLIC}>
			<input type="radio" name="host" value={PUBLIC} bind:group={selected} />
			<span class="option-mark" aria-hidden="true"></span>
			<span class="option-body">
				<span class="option-row">
					<span class="option-name">GitHub</span>
				</span>
				<span class="option-host">{PUBLIC}</span>
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
</div>

<style>
	.host {
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
		gap: 18px;
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
		color: var(--ob-text-label);
	}

	.option-host {
		font-family: var(--font-mono, 'JetBrains Mono', monospace);
		font-size: 12px;
		color: var(--ob-text-muted);
	}

	.actions {
		display: flex;
		justify-content: flex-end;
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
		transition: transform var(--duration-smooth) var(--ease-out-expo);
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

	@media (prefers-reduced-motion: reduce) {
		.option,
		.option[data-selected='true'] .option-mark::after,
		.actions {
			animation: none !important;
		}
	}
</style>
