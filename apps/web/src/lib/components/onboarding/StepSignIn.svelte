<script lang="ts">
	import { onMount } from 'svelte';
	import { Check, Copy, ChevronLeft } from '@lucide/svelte';
	import { Dotmatrix } from '$lib/components/ui/dotmatrix';
	import * as auth from '$lib/stores/auth.svelte';

	interface Props {
		onBack?: () => void;
	}

	let { onBack }: Props = $props();

	const error = $derived(auth.getError());
	const deviceFlow = $derived(auth.getDeviceFlow());
	const isLoading = $derived(auth.getIsLoading());

	let copied = $state(false);

	onMount(() => {
		auth.cancelSignIn();
		auth.clearError();
	});

	async function copyCode() {
		if (!deviceFlow) return;
		await navigator.clipboard.writeText(deviceFlow.userCode);
		copied = true;
		setTimeout(() => (copied = false), 1800);
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
				Enter this code on GitHub. We'll continue here once you authorize Revv.
			</p>

			<div class="code-wrap">
				<div class="code">
					{#each deviceFlow.userCode as char, i (i)}
						<span class="char" style="animation-delay: {i * 40}ms">{char}</span>
					{/each}
				</div>
				<button class="copy-btn" onclick={copyCode} aria-label="Copy code">
					{#if copied}
						<Check size={13} />
						<span>Copied</span>
					{:else}
						<Copy size={13} />
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
				<button class="cancel" onclick={auth.cancelSignIn}>Cancel</button>
			</div>
		</div>
	{:else}
		<div class="entry">
			{#if error}
				<p class="error">{error}</p>
			{/if}

			<p class="lede">
				Sign in with a device code — your token never leaves GitHub's servers
				until you authorize Revv.
			</p>

			<div class="actions">
				<button class="primary" onclick={auth.signIn} disabled={isLoading}>
					<span>{isLoading ? 'Opening GitHub…' : 'Sign in with GitHub'}</span>
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
		color: #6f6c63;
		font-family: var(--font-mono, 'JetBrains Mono', monospace);
		font-size: 10.5px;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		cursor: pointer;
		transition: color var(--duration-quick, 240ms) var(--ease-out-expo, cubic-bezier(0.16, 1, 0.3, 1));
	}

	.back:hover {
		color: #d4cab2;
	}

	.back :global(svg) {
		transition: transform var(--duration-quick, 240ms) var(--ease-out-expo, cubic-bezier(0.16, 1, 0.3, 1));
	}

	.back:hover :global(svg) {
		transform: translateX(-3px);
	}

	.lede {
		font-family: 'Newsreader', Georgia, serif;
		font-size: 17px;
		font-weight: 400;
		line-height: 1.6;
		color: #b4b0a4;
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
		color: #c98a8a;
		margin: 0;
		padding: 10px 14px;
		border-left: 2px solid #6f3a3a;
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
		border: 1px solid #46443d;
		border-radius: 2px;
		background: transparent;
		color: #f0ede4;
		font-family: 'Newsreader', Georgia, serif;
		font-style: italic;
		font-size: 16px;
		font-weight: 500;
		cursor: pointer;
		letter-spacing: 0.01em;
		transition:
			background-color 320ms cubic-bezier(0.16, 1, 0.3, 1),
			border-color 320ms cubic-bezier(0.16, 1, 0.3, 1),
			color 320ms cubic-bezier(0.16, 1, 0.3, 1),
			transform 280ms cubic-bezier(0.16, 1, 0.3, 1);
	}

	.primary svg {
		transition: transform 320ms cubic-bezier(0.16, 1, 0.3, 1);
	}

	.primary:hover:not(:disabled) {
		border-color: #d4cab2;
		color: #f7f4ec;
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
		border-top: 1px solid #2a2925;
		border-bottom: 1px solid #2a2925;
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
		color: #f0ede4;
		display: inline-block;
		animation: char-in 540ms cubic-bezier(0.16, 1, 0.3, 1) backwards;
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
		border: 1px solid #2a2925;
		border-radius: 2px;
		color: #8a8678;
		font-family: var(--font-mono, 'JetBrains Mono', monospace);
		font-size: 11px;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		cursor: pointer;
		transition: all 280ms cubic-bezier(0.16, 1, 0.3, 1);
	}

	.copy-btn:hover {
		border-color: #46443d;
		color: #d4cab2;
	}

	.link {
		font-family: var(--font-mono, 'JetBrains Mono', monospace);
		font-size: 12px;
		color: #6f6c63;
		text-decoration: none;
		transition: color 280ms cubic-bezier(0.16, 1, 0.3, 1);
	}

	.link:hover {
		color: #d4cab2;
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
		color: #8a8678;
		flex: 1;
	}

	.cancel {
		font-family: var(--font-mono, 'JetBrains Mono', monospace);
		font-size: 10.5px;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: #6f6c63;
		background: none;
		border: 0;
		cursor: pointer;
		padding: 4px 0;
		transition: color 280ms cubic-bezier(0.16, 1, 0.3, 1);
	}

	.cancel:hover {
		color: #d4cab2;
	}

	@media (prefers-reduced-motion: reduce) {
		.char {
			animation: none;
		}
	}
</style>
