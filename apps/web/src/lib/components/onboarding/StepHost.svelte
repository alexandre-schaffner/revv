<script lang="ts">
import CaretDown from "phosphor-svelte/lib/CaretDown";
import ChevronLeft from "phosphor-svelte/lib/CaretLeft";
import {
  cancelSignIn,
  clearToken,
  getIsAuthenticated,
  setForceOnboardingFlow,
} from "$lib/stores/auth.svelte";
import { getGithubClientId, getGithubHost, setGithubConfig } from "$lib/stores/settings.svelte";

interface Props {
  onContinue: () => void;
  onBack?: () => void;
}

let { onContinue, onBack }: Props = $props();

const PUBLIC = "github.com";
// Sentinel for the radio group — the actual host comes from `customHost`.
const CUSTOM = "custom";

// Resolve the initial selection from stored settings: the only host with a
// bundled client ID is github.com; anything else is a user-added GitHub
// Enterprise instance and goes through the custom path.
const storedHost = getGithubHost();
const isStoredCustom = storedHost !== null && storedHost !== PUBLIC;

let selected = $state<string>(isStoredCustom ? CUSTOM : PUBLIC);
let customHost = $state<string>(isStoredCustom ? (storedHost ?? "") : "");
let customClientId = $state<string>(isStoredCustom ? getGithubClientId() : "");
let showInstructions = $state(isStoredCustom);
let isSaving = $state(false);

/** Strip protocol, whitespace, and trailing slashes so the user can paste a URL. */
function normalizeHost(raw: string): string {
  return raw
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "")
    .trim();
}

const resolvedHost = $derived(selected === CUSTOM ? normalizeHost(customHost) : selected);
const resolvedClientId = $derived(selected === CUSTOM ? customClientId.trim() : "");
// Example URL for the "create a GitHub App" instructions — uses the host the
// user typed once it's present, otherwise a placeholder.
const appCreateUrl = $derived(`https://${resolvedHost || "your-ghe-host.com"}/settings/apps/new`);
const canContinue = $derived(
  selected !== CUSTOM || (resolvedHost.length > 0 && resolvedClientId.length > 0),
);

async function handleContinue() {
  if (!canContinue) return;

  const previousHost = getGithubHost();
  const hostChanged = previousHost !== null && previousHost !== resolvedHost;

  if (hostChanged && getIsAuthenticated()) {
    // Suppress the AccountPicker — we're still inside the onboarding
    // flow and about to re-authenticate with the new host.
    setForceOnboardingFlow();
    cancelSignIn();
    clearToken();
  }

  isSaving = true;
  try {
    // Bundled hosts carry no client ID; clear any previously-saved custom one.
    await setGithubConfig(resolvedHost, resolvedClientId);
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

		<label class="option" data-selected={selected === CUSTOM}>
			<input type="radio" name="host" value={CUSTOM} bind:group={selected} />
			<span class="option-mark" aria-hidden="true"></span>
			<span class="option-body">
				<span class="option-row">
					<span class="option-name">GitHub Enterprise</span>
				</span>
				<span class="option-host">your own Enterprise Cloud host (e.g. acme.ghe.com)</span>
			</span>
		</label>
	</fieldset>

	{#if selected === CUSTOM}
		<div class="custom">
			<div class="field">
				<label class="field-label" for="ghe-host">Enterprise host</label>
				<input
					id="ghe-host"
					class="field-input"
					type="text"
					autocapitalize="off"
					autocorrect="off"
					spellcheck="false"
					placeholder="acme.ghe.com"
					bind:value={customHost}
				/>
			</div>

			<div class="field">
				<label class="field-label" for="ghe-client-id">GitHub App client ID</label>
				<input
					id="ghe-client-id"
					class="field-input"
					type="text"
					autocapitalize="off"
					autocorrect="off"
					spellcheck="false"
					placeholder="Iv23xxxxxxxxxxxxxxxx"
					bind:value={customClientId}
				/>
				<p class="field-hint">
					Revv has no app registered on your instance — you create one and paste its
					public client ID here. It's safe to store (it isn't a secret).
				</p>
			</div>

			<div class="guide" data-open={showInstructions}>
				<button
					type="button"
					class="guide-toggle"
					aria-expanded={showInstructions}
					onclick={() => (showInstructions = !showInstructions)}
				>
					<CaretDown size={13} weight="bold" />
					<span>How to create the GitHub App</span>
				</button>

				{#if showInstructions}
					<ol class="guide-steps">
						<li>
							On your instance, open
							<a href={appCreateUrl} target="_blank" rel="noopener noreferrer" class="guide-link"
								>{appCreateUrl}</a
							>
							(or, for an org, its <em>Settings → Developer settings → GitHub Apps → New</em>).
						</li>
						<li>Name it <strong>Revv</strong>. Any homepage URL is fine.</li>
						<li>
							Under <em>Webhook</em>, <strong>uncheck “Active”</strong> — Revv polls locally and
							needs no webhook deliveries.
						</li>
						<li>
							Set <em>Repository permissions</em>:
							<span class="perms">
								<span><strong>Pull requests</strong> → Read &amp; write</span>
								<span><strong>Contents</strong> → Read &amp; write</span>
								<span><strong>Metadata</strong> → Read-only</span>
							</span>
							Leave everything else at <em>No access</em>.
						</li>
						<li>
							Under <em>Where can this GitHub App be installed?</em> pick whichever fits, then
							<strong>tick “Enable Device Flow.”</strong> Leave “Request user authorization (OAuth)
							during installation” unchecked.
						</li>
						<li>
							Create the app, copy its <strong>Client ID</strong> (starts with <code>Iv</code>),
							and paste it above.
						</li>
						<li>
							Finally, <strong>Install</strong> the app on the repositories you want Revv to see —
							you'll only review PRs from installed repos.
						</li>
					</ol>
				{/if}
			</div>
		</div>
	{/if}

	<div class="actions">
		<button class="primary" onclick={handleContinue} disabled={isSaving || !canContinue}>
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

	/* ── Custom GHE host ────────────────────────────────────────── */
	.custom {
		display: flex;
		flex-direction: column;
		gap: 22px;
		margin-top: -8px;
		animation: custom-in var(--duration-smooth) var(--ease-out-expo) backwards;
	}

	@keyframes custom-in {
		from {
			opacity: 0;
			transform: translateY(-4px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.field-label {
		font-family: var(--font-mono, 'JetBrains Mono', monospace);
		font-size: 10.5px;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--ob-text-label);
	}

	.field-input {
		width: 100%;
		padding: 11px 14px;
		background: var(--ob-hover-subtle);
		border: 1px solid var(--ob-border-btn);
		border-radius: 2px;
		color: var(--ob-text-heading);
		font-family: var(--font-mono, 'JetBrains Mono', monospace);
		font-size: 13px;
		letter-spacing: 0.01em;
		transition: border-color var(--duration-snap) var(--ease-out-expo);
	}

	.field-input::placeholder {
		color: var(--ob-text-muted);
	}

	.field-input:focus {
		outline: none;
		border-color: var(--ob-text-italic);
	}

	.field-hint {
		margin: 0;
		font-family: 'Newsreader', Georgia, serif;
		font-size: 13.5px;
		line-height: 1.55;
		color: var(--ob-text-muted);
	}

	.guide {
		border-top: 1px solid var(--ob-border);
		padding-top: 16px;
	}

	.guide-toggle {
		display: inline-flex;
		align-items: center;
		gap: 9px;
		background: none;
		border: 0;
		padding: 0;
		cursor: pointer;
		color: var(--ob-text-label);
		font-family: var(--font-mono, 'JetBrains Mono', monospace);
		font-size: 10.5px;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		transition: color var(--duration-snap) var(--ease-out-expo);
	}

	.guide-toggle:hover {
		color: var(--ob-text-italic);
	}

	.guide-toggle :global(svg) {
		transition: transform var(--duration-quick) var(--ease-out-expo);
	}

	.guide[data-open='true'] .guide-toggle :global(svg) {
		transform: rotate(180deg);
	}

	.guide-steps {
		margin: 16px 0 0;
		padding-left: 20px;
		display: flex;
		flex-direction: column;
		gap: 12px;
		font-family: 'Newsreader', Georgia, serif;
		font-size: 14.5px;
		line-height: 1.6;
		color: var(--ob-text-body);
		animation: custom-in var(--duration-smooth) var(--ease-out-expo) backwards;
	}

	.guide-steps li {
		padding-left: 4px;
	}

	.guide-steps em {
		color: var(--ob-text-italic);
		font-style: italic;
	}

	.guide-steps strong {
		color: var(--ob-text-heading);
		font-weight: 600;
	}

	.perms {
		display: flex;
		flex-direction: column;
		gap: 4px;
		margin: 8px 0;
		font-family: var(--font-mono, 'JetBrains Mono', monospace);
		font-size: 12px;
		color: var(--ob-text-body);
	}

	.guide-steps code {
		font-family: var(--font-mono, 'JetBrains Mono', monospace);
		font-size: 12.5px;
		padding: 1px 5px;
		border-radius: 3px;
		background: var(--ob-hover-subtle);
		color: var(--ob-text-heading);
	}

	.guide-link {
		color: var(--ob-text-muted);
		word-break: break-all;
		transition: color var(--duration-snap) var(--ease-out-expo);
	}

	.guide-link:hover {
		color: var(--ob-text-italic);
	}

	@media (prefers-reduced-motion: reduce) {
		.custom,
		.guide-steps {
			animation: none !important;
		}

		.option,
		.option[data-selected='true'] .option-mark::after,
		.actions {
			animation: none !important;
		}
	}
</style>
