<script lang="ts">
import CaretDown from "phosphor-svelte/lib/CaretDown";
import ChevronLeft from "phosphor-svelte/lib/CaretLeft";
import GithubLogo from "phosphor-svelte/lib/GithubLogo";
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
					<span class="guide-toggle-copy">
						<span class="guide-icon" aria-hidden="true">
							<GithubLogo size={15} weight="fill" />
						</span>
						<span>
							<span class="guide-title">How to create the GitHub App</span>
							<span class="guide-subtitle">Enterprise setup checklist</span>
						</span>
					</span>
					<span class="guide-caret" aria-hidden="true">
						<CaretDown size={13} weight="bold" />
					</span>
				</button>

				{#if showInstructions}
					<ol class="guide-steps">
						<li>
							<span class="step-copy">
								<span class="step-title">Open the new app page</span>
								<span class="step-detail">
									On your instance, open
									<a href={appCreateUrl} target="_blank" rel="noopener noreferrer" class="guide-link"
										>{appCreateUrl}</a
									>
									or use <em>Settings -> Developer settings -> GitHub Apps -> New</em> for an org.
								</span>
							</span>
						</li>
						<li>
							<span class="step-copy">
								<span class="step-title">Name the app</span>
								<span class="step-detail">Use <strong>Revv</strong>. Any homepage URL is fine.</span>
							</span>
						</li>
						<li>
							<span class="step-copy">
								<span class="step-title">Disable webhooks</span>
								<span class="step-detail">
									Under <em>Webhook</em>, <strong>uncheck "Active"</strong>. Revv polls locally and
									does not need webhook deliveries.
								</span>
							</span>
						</li>
						<li>
							<span class="step-copy">
								<span class="step-title">Set repository permissions</span>
								<span class="permission-grid" aria-label="Required repository permissions">
									<span><strong>Pull requests</strong><span>Read &amp; write</span></span>
									<span><strong>Contents</strong><span>Read &amp; write</span></span>
									<span><strong>Metadata</strong><span>Read-only</span></span>
								</span>
								<span class="step-detail">Leave everything else at <em>No access</em>.</span>
							</span>
						</li>
						<li>
							<span class="step-copy">
								<span class="step-title">Enable device flow</span>
								<span class="step-detail">
									Under <em>Where can this GitHub App be installed?</em> pick whichever fits, then
									<strong>tick "Enable Device Flow."</strong> Leave
									<em>Request user authorization (OAuth) during installation</em> unchecked.
								</span>
							</span>
						</li>
						<li>
							<span class="step-copy">
								<span class="step-title">Copy the client ID</span>
								<span class="step-detail">
									Create the app, copy its <strong>Client ID</strong> (starts with <code>Iv</code>),
									and paste it above.
								</span>
							</span>
						</li>
						<li>
							<span class="step-copy">
								<span class="step-title">Install it on repositories</span>
								<span class="step-detail">
									Install the app on the repositories you want Revv to see. You can only review PRs
									from installed repos.
								</span>
							</span>
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
		border: 1px solid var(--ob-border);
		border-radius: 10px;
		background:
			linear-gradient(180deg, var(--ob-hover-subtle), transparent 120px),
			color-mix(in srgb, var(--ob-bg) 86%, var(--ob-border-subtle));
		min-height: 0;
	}

	.guide-toggle {
		width: 100%;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 14px;
		background: none;
		border: 0;
		padding: 13px 14px;
		cursor: pointer;
		color: var(--ob-text-heading);
		text-align: left;
		transition: color var(--duration-snap) var(--ease-out-expo);
	}

	.guide-toggle:hover {
		color: var(--ob-text-heading-bright);
	}

	.guide-toggle :global(svg) {
		transition: transform var(--duration-quick) var(--ease-out-expo);
	}

	.guide-toggle-copy {
		display: flex;
		align-items: center;
		gap: 11px;
		min-width: 0;
	}

	.guide-icon {
		display: grid;
		place-items: center;
		width: 26px;
		height: 26px;
		flex: 0 0 auto;
		border: 1px solid var(--ob-border);
		border-radius: 7px;
		background: var(--ob-hover-subtle);
		color: var(--ob-text-italic);
	}

	.guide-title,
	.guide-subtitle {
		display: block;
	}

	.guide-title {
		font-family: var(--font-sans, 'Inter', system-ui, sans-serif);
		font-size: 13px;
		font-weight: 600;
		letter-spacing: 0;
		line-height: 1.25;
	}

	.guide-subtitle {
		margin-top: 2px;
		font-family: var(--font-mono, 'JetBrains Mono', monospace);
		font-size: 10px;
		letter-spacing: 0.09em;
		text-transform: uppercase;
		color: var(--ob-text-muted);
	}

	.guide-caret {
		flex: 0 0 auto;
		color: var(--ob-text-muted);
	}

	.guide[data-open='true'] .guide-caret {
		transform: rotate(180deg);
	}

	.guide-steps {
		counter-reset: setup-step;
		margin: 0;
		padding: 2px 14px 12px;
		display: flex;
		flex-direction: column;
		gap: 0;
		font-family: var(--font-sans, 'Inter', system-ui, sans-serif);
		font-size: 13px;
		line-height: 1.5;
		color: var(--ob-text-body);
		animation: custom-in var(--duration-smooth) var(--ease-out-expo) backwards;
		list-style: none;
	}

	.guide-steps li {
		counter-increment: setup-step;
		position: relative;
		display: grid;
		grid-template-columns: 24px 1fr;
		gap: 10px;
		padding: 10px 0;
		border-top: 1px solid var(--ob-border-subtle);
	}

	.guide-steps li::before {
		content: counter(setup-step);
		display: grid;
		place-items: center;
		width: 22px;
		height: 22px;
		margin-top: 1px;
		border: 1px solid var(--ob-border);
		border-radius: 999px;
		background: var(--ob-bg);
		color: var(--ob-text-italic);
		font-family: var(--font-mono, 'JetBrains Mono', monospace);
		font-size: 10px;
		line-height: 1;
	}

	.step-copy {
		display: flex;
		flex-direction: column;
		gap: 4px;
		min-width: 0;
	}

	.step-title {
		color: var(--ob-text-heading);
		font-size: 13px;
		font-weight: 600;
		line-height: 1.35;
	}

	.step-detail {
		color: var(--ob-text-body);
	}

	.step-detail,
	.permission-grid {
		max-width: 62ch;
	}

	.guide-steps em {
		color: var(--ob-text-italic);
		font-style: italic;
	}

	.guide-steps strong {
		color: var(--ob-text-heading);
		font-weight: 600;
	}

	.permission-grid {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 1px;
		margin: 8px 0;
		border: 1px solid var(--ob-border);
		border-radius: 8px;
		overflow: hidden;
		background: var(--ob-border);
	}

	.permission-grid > span {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 3px;
		padding: 8px 10px;
		background: color-mix(in srgb, var(--ob-bg) 92%, var(--ob-hover-subtle));
	}

	.permission-grid strong,
	.permission-grid span span {
		overflow-wrap: anywhere;
	}

	.permission-grid strong {
		font-family: var(--font-sans, 'Inter', system-ui, sans-serif);
		font-size: 12px;
		line-height: 1.3;
	}

	.permission-grid span span {
		font-family: var(--font-mono, 'JetBrains Mono', monospace);
		font-size: 10.5px;
		line-height: 1.35;
		color: var(--ob-text-muted);
	}

	.guide-steps code {
		font-family: var(--font-mono, 'JetBrains Mono', monospace);
		font-size: 12px;
		padding: 1px 5px;
		border-radius: 3px;
		background: var(--ob-hover-subtle);
		color: var(--ob-text-heading);
	}

	.guide-link {
		color: var(--ob-text-italic);
		font-family: var(--font-mono, 'JetBrains Mono', monospace);
		font-size: 12px;
		word-break: break-all;
		transition: color var(--duration-snap) var(--ease-out-expo);
	}

	.guide-link:hover {
		color: var(--ob-text-heading);
	}

	@media (max-width: 640px) {
		.permission-grid {
			grid-template-columns: 1fr;
		}
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
