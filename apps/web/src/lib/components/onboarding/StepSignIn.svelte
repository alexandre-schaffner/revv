<script lang="ts">
import ChevronLeft from "phosphor-svelte/lib/CaretLeft";
import Check from "phosphor-svelte/lib/Check";
import Copy from "phosphor-svelte/lib/Copy";
import { onMount } from "svelte";
import { Dotmatrix } from "$lib/components/ui/dotmatrix";
import {
  cancelSignIn,
  clearError,
  getDeviceFlow,
  getError,
  getIsLoading,
  signIn,
} from "$lib/stores/auth.svelte";

interface Props {
  onBack?: () => void;
  githubHost?: string;
}

let { onBack, githubHost = "github.com" }: Props = $props();

const isGhe = $derived(githubHost !== "github.com");
const hostLabel = $derived(isGhe ? githubHost : "GitHub");

const error = $derived(getError());
const deviceFlow = $derived(getDeviceFlow());
const isLoading = $derived(getIsLoading());

let copied = $state(false);

onMount(() => {
  cancelSignIn();
  clearError();
});

async function copyCode() {
  if (!deviceFlow) return;
  try {
    await navigator.clipboard.writeText(deviceFlow.userCode);
    copied = true;
    setTimeout(() => (copied = false), 2000);
  } catch {
    // Clipboard API may be unavailable in some contexts
  }
}
</script>

<div class="signin">
	{#if onBack}
		<button class="back" onclick={onBack}>
			<ChevronLeft size={14} />
			<span>Back</span>
		</button>
	{/if}

	{#if deviceFlow}
		<div class="device-flow">
			<p class="lede">
				Enter this code on {hostLabel}. We'll continue here once you authorize Revv.
			</p>

			<div class="code-wrap">
				<div class="code">
					{#each deviceFlow.userCode as char, i (i)}
						<span class="char" style="animation-delay: {i * 40}ms">{char}</span>
					{/each}
				</div>
				<button class="copy-btn" onclick={copyCode} aria-label="Copy code">
					{#if copied}
						<Check size={13} weight="regular" />
						<span>Copied</span>
					{:else}
						<Copy size={13} weight="fill" />
						<span>Copy</span>
					{/if}
				</button>
			</div>

			<a
				href={deviceFlow.verificationUri}
				target="_blank"
				rel="noopener noreferrer"
				class="link"
			>
				{deviceFlow.verificationUri}
			</a>

			<div class="waiting">
				<Dotmatrix variant="square-13" size="small" />
				<span class="waiting-text">Awaiting authorization</span>
				<button class="cancel" onclick={cancelSignIn}>Cancel</button>
			</div>
		</div>
	{:else}
		<div class="entry">
			{#if error}
				<p class="error">{error}</p>
			{/if}

			<p class="lede">
			Sign in with a device code — your token never leaves {hostLabel}'s servers
			until you authorize Revv.
			</p>

			<div class="actions">
				<button class="primary" onclick={() => signIn(isGhe ? githubHost : undefined)} disabled={isLoading}>
					<span>{isLoading ? `Opening ${hostLabel}…` : `Sign in with ${hostLabel}`}</span>
					{#if !isLoading}
						<svg
							width="18"
							height="10"
							viewBox="0 0 18 10"
							fill="none"
							xmlns="http://www.w3.org/2000/svg"
							aria-hidden="true"
						>
							<path
								d="M0 5h16M12 1l4 4-4 4"
								stroke="currentColor"
								stroke-width="1"
								stroke-linecap="round"
								stroke-linejoin="round"
							/>
						</svg>
					{/if}
				</button>
			</div>
		</div>
	{/if}
</div>

<style>
	.signin {
		display: flex;
		flex-direction: column;
		flex: 1;
		gap: 24px;
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

	/* ── Entry state ────────────────────────────────────────────── */
	.entry {
		display: flex;
		flex-direction: column;
		gap: 28px;
	}

	.error {
		font-family: 'Newsreader', Georgia, serif;
		font-size: 14px;
		color: var(--ob-error);
		margin: 0;
		padding: 10px 14px;
		border: 1px solid var(--ob-error-border);
		background: color-mix(in srgb, var(--ob-error) 6%, transparent);
		border-radius: 6px;
	}

	.actions {
		display: flex;
		gap: 18px;
		align-items: center;
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

	.primary:hover:not(:disabled) {
		border-color: var(--ob-text-italic);
		color: var(--ob-text-heading-bright);
	}

	.primary:hover:not(:disabled) svg {
		transform: translateX(4px);
	}

	.primary:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	/* ── Device-flow state ──────────────────────────────────────── */
	.device-flow {
		display: flex;
		flex-direction: column;
		gap: 28px;
	}

	.code-wrap {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 24px;
		padding: 22px 4px;
		border-top: 1px solid var(--ob-border);
		border-bottom: 1px solid var(--ob-border);
	}

	.code {
		display: inline-flex;
		gap: 6px;
	}

	.char {
		font-family: var(--font-mono, 'JetBrains Mono', monospace);
		font-size: 30px;
		font-weight: 500;
		letter-spacing: 0.04em;
		color: var(--ob-text-heading);
		display: inline-block;
		animation: char-in var(--duration-ceremonial-medium) var(--ease-out-expo) backwards;
	}

	@keyframes char-in {
		from {
			opacity: 0;
			transform: translateY(8px);
			filter: blur(3px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
			filter: blur(0);
		}
	}

	.copy-btn {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		padding: 8px 12px;
		background: transparent;
		border: 1px solid var(--ob-border);
		border-radius: 2px;
		color: var(--ob-text-label);
		font-family: var(--font-mono, 'JetBrains Mono', monospace);
		font-size: 11px;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		cursor: pointer;
		transition:
			border-color var(--duration-snap) var(--ease-out-expo),
			color var(--duration-snap) var(--ease-out-expo);
	}

	.copy-btn:hover {
		border-color: var(--ob-border-btn);
		color: var(--ob-text-italic);
	}

	.link {
		font-family: var(--font-mono, 'JetBrains Mono', monospace);
		font-size: 12px;
		color: var(--ob-text-muted);
		text-decoration: none;
		transition: color var(--duration-snap) var(--ease-out-expo);
	}

	.link:hover {
		color: var(--ob-text-italic);
	}

	.waiting {
		display: flex;
		align-items: center;
		gap: 14px;
		padding-top: 4px;
	}

	.waiting-text {
		font-family: var(--font-mono, 'JetBrains Mono', monospace);
		font-size: 11px;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: var(--ob-text-label);
		flex: 1;
	}

	.cancel {
		font-family: var(--font-mono, 'JetBrains Mono', monospace);
		font-size: 10.5px;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: var(--ob-text-muted);
		background: none;
		border: 0;
		cursor: pointer;
		padding: 4px 0;
		transition: color var(--duration-snap) var(--ease-out-expo);
	}

	.cancel:hover {
		color: var(--ob-text-italic);
	}

	@media (prefers-reduced-motion: reduce) {
		.char {
			animation: none;
		}
	}
</style>
